import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ExampleHomebridgePlatform } from './platform';
import { AsyncDeviceDiscovery, Sonos, Listener } from 'sonos';

function getGroupMembers(group: any): Sonos[] {
  return group.ZoneGroupMember.map((member: any) => new Sonos(member.Location.match(/(?<=http:\/\/)(.*?)(?=:\d+)/)[0], undefined, undefined));
}

async function adjustVolume(device: Sonos): Promise<void> {
  const name = await device.getName();
  await device.setVolume(name === 'Sonos Roam' ? 24 : 12);
}

function flatten<T>(array: T[][]): T[] {
  return array.reduce((acc, val) => acc.concat(val), []);
}

class Sequencer {

  private current: Promise<unknown> = Promise.resolve(null);

  queue<T>(promiseTask: () => Promise<T>): Promise<T> {
    return this.current = this.current.then(() => promiseTask(), () => promiseTask());
  }
}

class SonosController {

  private sequencer = new Sequencer();
  private device: Sonos | undefined;
  private lastUpdated: number = 0;

  constructor(
    private readonly platform: ExampleHomebridgePlatform
  ) { }

  private async getDevice() {
    return this.sequencer.queue(() => this._getDevice());
  }

  private async _getDevice() {
    if (!this.device || Date.now() - this.lastUpdated > 2 * 60 * 1000) {
      this.device = undefined;
      const discovery = new AsyncDeviceDiscovery();
      const discoveryResult = await discovery.discover();
      this.device = discoveryResult.device;
      this.lastUpdated = Date.now();
    }

    return this.device;
  }

  async status() {
    const device = await this.getDevice();
    const groups = await device.getAllGroups();
    const groupDevices = groups.map<Sonos>(group => group.CoordinatorDevice());
    const states = await Promise.all(groupDevices.map(g => g.getCurrentState()));
    const result = states.some(state => state === 'playing');

    this.platform.log.info('Get Characteristic On ->', result);

    return result;
  }

  async play() {
    this.platform.log.info('Setting up GDS.FM...');

    try {
      const device = await this.getDevice();
      const groups = await device.getAllGroups();

      if (groups.length === 0) {
        this.platform.log.warn('Found no Sonos devices');
        return;
      }

      const [mainGroup, ...otherGroups] = groups;
      const mainDevice = mainGroup.CoordinatorDevice() as Sonos;

      const mainMembers = getGroupMembers(mainGroup);
      const promises: Promise<any>[] = mainMembers.map(member => adjustVolume(member));

      const otherMembers = flatten(otherGroups.map(group => getGroupMembers(group)));

      if (otherMembers.length > 0) {
        const mainDeviceName = await mainDevice.getName();
        promises.push(...otherMembers.map(member => Promise.all([
          member.joinGroup(mainDeviceName),
          adjustVolume(member)
        ])));
      }

      await Promise.all(promises);
      await mainDevice.playTuneinRadio('s218325', 'GDS.FM');
      this.platform.log.info('Started playing GDS.FM');
    } catch (err: any) {
      this.platform.log.error('Failed to start GDS.FM', err.message || err);
      this.device = undefined;
    }
  }

  async pause() {
    this.platform.log.info('Stopping GDS.FM...');

    try {
      const device = await this.getDevice();
      const groups = await device.getAllGroups();
      const groupDevices = groups.map<Sonos>(group => group.CoordinatorDevice());
      await Promise.all(groupDevices.map(g => g.stop()));
      this.platform.log.info('Stopped playing Sonos');
    } catch (err: any) {
      this.platform.log.error('Failed to start GDS.FM', err.message || err);
      this.device = undefined;
    }
  }
}

export class ExamplePlatformAccessory {

  private service: Service;
  private controller: SonosController;

  constructor(
    private readonly platform: ExampleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.controller = new SonosController(platform);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(this.platform.Characteristic.Name, 'GDS.FM');
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet((value) => {
        if (value) {
          this.controller.play();
        } else {
          this.controller.pause();
        }
      })
      .onGet(() => this.controller.status());
  }
}
