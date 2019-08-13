import deferrable from 'golike-defer'
import { find, gte, includes, isEmpty, lte, noop } from 'lodash'
import { ignoreErrors, pCatch } from 'promise-toolbox'
import { NULL_REF } from 'xen-api'

import { forEach, mapToArray, parseSize } from '../../utils'

import {
  extractOpaqueRef,
  isVmHvm,
  isVmRunning,
  makeEditObject,
} from '../utils'

// According to: https://xenserver.org/blog/entry/vga-over-cirrus-in-xenserver-6-2.html.
const XEN_VGA_VALUES = ['std', 'cirrus']
const XEN_VIDEORAM_VALUES = [1, 2, 4, 8, 16]

export default {
  // https://xapi-project.github.io/xen-api/classes/vm.html#checkpoint
  async checkpointVm(vmId, nameLabel) {
    const vm = this.getObject(vmId)
    try {
      const ref = await this.callAsync(
        'VM.checkpoint',
        vm.$ref,
        nameLabel != null ? nameLabel : vm.name_label
      ).then(extractOpaqueRef)
      return this.barrier(ref)
    } catch (error) {
      if (error.code === 'VM_BAD_POWER_STATE') {
        return this._snapshotVm(vm, nameLabel)
      }
      throw error
    }
  },

  // TODO: clean up on error.
  @deferrable
  async createVm(
    $defer,
    templateId,
    {
      name_label, // eslint-disable-line camelcase
      nameLabel = name_label, // eslint-disable-line camelcase

      clone = true,
      installRepository = undefined,
      vdis = undefined,
      vifs = undefined,
      existingVdis = undefined,

      coreOs = false,
      cloudConfig = undefined,
      networkConfig = undefined,

      vgpuType = undefined,
      gpuGroup = undefined,

      ...props
    } = {},
    checkLimits
  ) {
    const installMethod = (() => {
      if (installRepository == null) {
        return 'none'
      }

      try {
        installRepository = this.getObject(installRepository)
        return 'cd'
      } catch (_) {
        return 'network'
      }
    })()
    const template = this.getObject(templateId)

    // Clones the template.
    const vmRef = await this[clone ? '_cloneVm' : '_copyVm'](
      template,
      nameLabel
    )
    $defer.onFailure(() => this.deleteVm(vmRef))

    // TODO: copy BIOS strings?

    // Removes disks from the provision XML, we will create them by
    // ourselves.
    await this.call(
      'VM.remove_from_other_config',
      vmRef,
      'disks'
    )::ignoreErrors()

    // Creates the VDIs and executes the initial steps of the
    // installation.
    await this.callAsync('VM.provision', vmRef)

    let vm = await this._getOrWaitObject(vmRef)

    // Set VMs params.
    await this._editVm(vm, props, checkLimits)

    // Sets boot parameters.
    {
      const isHvm = isVmHvm(vm)

      if (isHvm) {
        if (!isEmpty(vdis) || installMethod === 'network') {
          const { order } = vm.HVM_boot_params

          vm.update_HVM_boot_params(
            'order',
            order ? 'n' + order.replace('n', '') : 'ncd'
          )
        }
      } else {
        // PV
        if (vm.PV_bootloader === 'eliloader') {
          if (installMethod === 'network') {
            // TODO: normalize RHEL URL?

            await vm.update_other_config(
              'install-repository',
              installRepository
            )
          } else if (installMethod === 'cd') {
            await vm.update_other_config('install-repository', 'cdrom')
          }
        }
      }
    }

    let hasBootableDisk = !!find(vm.$VBDs, 'bootable')

    // Inserts the CD if necessary.
    if (installMethod === 'cd') {
      // When the VM is started, if PV, the CD drive will become not
      // bootable and the first disk bootable.
      await this._insertCdIntoVm(installRepository, vm, {
        bootable: true,
      })
      hasBootableDisk = true
    }

    // Modify existing (previous template) disks if necessary
    existingVdis &&
      (await Promise.all(
        mapToArray(
          existingVdis,
          async ({ size, $SR: srId, ...properties }, userdevice) => {
            const vbd = find(vm.$VBDs, { userdevice })
            if (!vbd) {
              return
            }
            const vdi = vbd.$VDI
            await this._setObjectProperties(vdi, properties)

            // if the disk is bigger
            if (size != null && size > vdi.virtual_size) {
              await this.resizeVdi(vdi.$id, size)
            }
            // if another SR is set, move it there
            if (srId) {
              await this.moveVdi(vdi.$id, srId)
            }
          }
        )
      ))

    // Creates the user defined VDIs.
    //
    // TODO: set vm.suspend_SR
    if (!isEmpty(vdis)) {
      const devices = await this.call('VM.get_allowed_VBD_devices', vm.$ref)
      await Promise.all(
        mapToArray(vdis, (vdiDescription, i) =>
          this.createVdi({
            name_description: vdiDescription.name_description,
            name_label: vdiDescription.name_label,
            size: vdiDescription.size,
            sr: vdiDescription.sr || vdiDescription.SR,
          }).then(vdi =>
            this.createVbd({
              // Either the CD or the 1st disk is bootable (only useful for PV VMs)
              bootable: !(hasBootableDisk || i),

              userdevice: devices[i],
              vdi,
              vm,
            })
          )
        )
      )
    }

    // Destroys the VIFs cloned from the template.
    await Promise.all(mapToArray(vm.$VIFs, vif => this._deleteVif(vif)))

    // Creates the VIFs specified by the user.
    if (vifs) {
      const devices = await this.call('VM.get_allowed_VIF_devices', vm.$ref)
      await Promise.all(
        mapToArray(vifs, (vif, index) =>
          this._createVif(vm, this.getObject(vif.network), {
            ipv4_allowed: vif.ipv4_allowed,
            ipv6_allowed: vif.ipv6_allowed,
            device: devices[index],
            locking_mode:
              isEmpty(vif.ipv4_allowed) && isEmpty(vif.ipv6_allowed)
                ? 'network_default'
                : 'locked',
            mac: vif.mac,
            mtu: vif.mtu,
          })
        )
      )
    }

    if (vgpuType !== undefined && gpuGroup !== undefined) {
      await this.createVgpu(vm, gpuGroup, vgpuType)
    }

    if (cloudConfig != null) {
      // Refresh the record.
      await this.barrier(vm.$ref)
      vm = this.getObjectByRef(vm.$ref)

      // Find the SR of the first VDI.
      let srRef
      forEach(vm.$VBDs, vbd => {
        let vdi
        if (vbd.type === 'Disk' && (vdi = vbd.$VDI)) {
          srRef = vdi.SR
          return false
        }
      })

      if (coreOs) {
        await this.createCoreOsCloudInitConfigDrive(vm.$id, srRef, cloudConfig)
      } else {
        await this.createCloudInitConfigDrive(
          vm.$id,
          srRef,
          cloudConfig,
          networkConfig
        )
      }
    }

    // wait for the record with all the VBDs and VIFs
    return this.barrier(vm.$ref)
  },

  // High level method to edit a VM.
  //
  // Params do not correspond directly to XAPI props.
  _editVm: makeEditObject({
    affinityHost: {
      get: 'affinity',
      set: (value, vm) =>
        vm.set_affinity(value ? vm.$xapi.getObject(value).$ref : NULL_REF),
    },

    autoPoweron: {
      set(value, vm) {
        return Promise.all([
          vm.update_other_config('auto_poweron', value ? 'true' : null),
          value && vm.$pool.update_other_config('auto_poweron', 'true'),
        ])
      },
    },

    virtualizationMode: {
      set(virtualizationMode, vm) {
        if (virtualizationMode !== 'pv' && virtualizationMode !== 'hvm') {
          throw new Error(`The virtualization mode must be 'pv' or 'hvm'`)
        }
        return vm
          .set_domain_type(virtualizationMode)
          ::pCatch({ code: 'MESSAGE_METHOD_UNKNOWN' }, () =>
            vm.set_HVM_boot_policy(
              virtualizationMode === 'hvm' ? 'Boot order' : ''
            )
          )
      },
    },

    coresPerSocket: {
      set: (coresPerSocket, vm) =>
        vm.update_platform('cores-per-socket', String(coresPerSocket)),
    },

    CPUs: 'cpus',
    cpus: {
      addToLimits: true,

      // Current value may have constraints with other values.
      //
      // If the other value is not set and the constraint is not
      // respected, the other value is changed first.
      constraints: {
        cpusStaticMax: gte,
      },

      get: vm => +vm.VCPUs_at_startup,
      set: [
        'VCPUs_at_startup',
        (value, vm) =>
          isVmRunning(vm) &&
          vm.$xapi.call('VM.set_VCPUs_number_live', vm.$ref, String(value)),
      ],
    },

    cpuCap: {
      get: vm => vm.VCPUs_params.cap && +vm.VCPUs_params.cap,
      set: (cap, vm) => vm.update_VCPUs_params('cap', String(cap)),
    },

    cpuMask: {
      get: vm => vm.VCPUs_params.mask && vm.VCPUs_params.mask.split(','),
      set: (cpuMask, vm) =>
        vm.update_VCPUs_params(
          'mask',
          cpuMask == null ? cpuMask : cpuMask.join(',')
        ),
    },

    cpusMax: 'cpusStaticMax',
    cpusStaticMax: {
      constraints: {
        cpus: lte,
      },
      get: vm => +vm.VCPUs_max,
      set: 'VCPUs_max',
    },

    cpuWeight: {
      get: vm => vm.VCPUs_params.weight && +vm.VCPUs_params.weight,
      set: (weight, vm) =>
        vm.update_VCPUs_params(
          'weight',
          weight === null ? null : String(weight)
        ),
    },

    highAvailability: {
      set: (ha, vm) => vm.set_ha_restart_priority(ha),
    },

    memoryMin: {
      constraints: {
        memoryMax: gte,
      },
      get: vm => +vm.memory_dynamic_min,
      preprocess: parseSize,
      set: 'memory_dynamic_min',
    },

    memory: 'memoryMax',
    memoryMax: {
      addToLimits: true,
      limitName: 'memory',
      get: vm => +vm.memory_dynamic_max,
      preprocess: parseSize,
      set(dynamicMax, vm) {
        const { $ref } = vm
        const dynamicMin = Math.min(vm.memory_dynamic_min, dynamicMax)

        if (isVmRunning(vm)) {
          return this.call(
            'VM.set_memory_dynamic_range',
            $ref,
            dynamicMin,
            dynamicMax
          )
        }

        const staticMin = Math.min(vm.memory_static_min, dynamicMax)
        return this.call(
          'VM.set_memory_limits',
          $ref,
          staticMin,
          Math.max(dynamicMax, vm.memory_static_max),
          dynamicMin,
          dynamicMax
        )::pCatch({ code: 'MEMORY_CONSTRAINT_VIOLATION' }, () =>
          this.call(
            'VM.set_memory_limits',
            $ref,
            staticMin,
            dynamicMax,
            dynamicMax,
            dynamicMax
          )
        )
      },
    },

    memoryStaticMax: {
      constraints: {
        memoryMax: lte,
      },
      get: vm => +vm.memory_static_max,
      preprocess: parseSize,
      set: 'memory_static_max',
    },

    nameDescription: true,

    nameLabel: true,

    PV_args: true,

    tags: true,

    hasVendorDevice: true,

    expNestedHvm: {
      set: (expNestedHvm, vm) =>
        vm.update_platform('exp-nested-hvm', expNestedHvm ? 'true' : null),
    },

    nicType: {
      set: (nicType, vm) => vm.update_platform('nic_type', nicType),
    },

    vga: {
      set(vga, vm) {
        if (!includes(XEN_VGA_VALUES, vga)) {
          throw new Error(
            `The different values that the VGA can take are: ${XEN_VGA_VALUES}`
          )
        }
        return vm.update_platform('vga', vga)
      },
    },

    videoram: {
      set(videoram, vm) {
        if (!includes(XEN_VIDEORAM_VALUES, videoram)) {
          throw new Error(
            `The different values that the video RAM can take are: ${XEN_VIDEORAM_VALUES}`
          )
        }
        return vm.update_platform('videoram', String(videoram))
      },
    },

    startDelay: {
      get: vm => +vm.start_delay,
      set: (startDelay, vm) => vm.set_start_delay(startDelay),
    },

    hvmBootFirmware: {
      set: (firmware, vm) => vm.update_HVM_boot_params('firmware', firmware),
    },
  }),

  async editVm(id, props, checkLimits) {
    return /* await */ this._editVm(this.getObject(id), props, checkLimits)
  },

  async revertVm(snapshotId, snapshotBefore = true) {
    const snapshot = this.getObject(snapshotId)
    let newSnapshot
    if (snapshotBefore) {
      newSnapshot = await this._snapshotVm(snapshot.$snapshot_of)
    }
    await this.callAsync('VM.revert', snapshot.$ref)
    if (snapshot.snapshot_info['power-state-at-snapshot'] === 'Running') {
      const vm = await this.barrier(snapshot.snapshot_of)
      if (vm.power_state === 'Halted') {
        this.startVm(vm.$id)::ignoreErrors()
      } else if (vm.power_state === 'Suspended') {
        this.resumeVm(vm.$id)::ignoreErrors()
      }
    }
    return newSnapshot
  },

  async resumeVm(vmId) {
    // the force parameter is always true
    await this.callAsync('VM.resume', this.getObject(vmId).$ref, false, true)
  },

  async unpauseVm(vmId) {
    await this.callAsync('VM.unpause', this.getObject(vmId).$ref)
  },

  rebootVm(vmId, { hard = false } = {}) {
    return this.callAsync(
      `VM.${hard ? 'hard' : 'clean'}_reboot`,
      this.getObject(vmId).$ref
    ).then(noop)
  },

  shutdownVm(vmId, { hard = false } = {}) {
    return this.callAsync(
      `VM.${hard ? 'hard' : 'clean'}_shutdown`,
      this.getObject(vmId).$ref
    ).then(noop)
  },
}
