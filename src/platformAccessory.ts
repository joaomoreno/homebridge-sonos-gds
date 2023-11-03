import { Service, PlatformAccessory } from 'homebridge';
import { ExampleHomebridgePlatform } from './platform';
import { AsyncDeviceDiscovery, Sonos } from 'sonos';

function getGroupMembers(group: any): Sonos[] {
  return group.ZoneGroupMember.map((member: any) => new Sonos(member.Location.match(/(?<=http:\/\/)(.*?)(?=:\d+)/)[0], undefined, undefined));
}

async function adjustVolume(device: Sonos): Promise<void> {
  const name = await device.getName();
  await device.setVolume(name === 'Sonos Roam' ? 20 : 10);
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
    this.platform.log.info(`Sonos states: ${states}`);

    return states.some(state => state === 'playing');
  }

  async play() {
    this.platform.log.info('Setting up GDS.FM...');

    try {
      this.platform.log.info('Getting device...');
      const device = await this.getDevice();

      this.platform.log.info('Getting all groups...');
      const groups = await device.getAllGroups();

      if (groups.length === 0) {
        this.platform.log.warn('Found no Sonos devices');
        return;
      }

      this.platform.log.info(`Found ${groups.length} groups`);
      const [mainGroup, ...otherGroups] = groups;
      const mainDevice = mainGroup.CoordinatorDevice() as Sonos;

      const mainMembers = getGroupMembers(mainGroup);
      const promises: Promise<any>[] = mainMembers.map(async member => {
        const then = Date.now();
        await adjustVolume(member);
        this.platform.log.info(`[${member.host}] Took ${Date.now() - then}ms to adjust volume`);
      });

      const otherMembers = flatten(otherGroups.map(group => getGroupMembers(group)));

      if (otherMembers.length > 0) {
        this.platform.log.info(`Found ${otherMembers.length} that need to join the group`);

        this.platform.log.info(`Getting main device name...`);
        const mainDeviceName = await mainDevice.getName();
        this.platform.log.info(`Main device name: ${mainDeviceName}`);

        promises.push(...otherMembers.map(async member => {
          const then = Date.now();

          await Promise.all([
            (async () => {
              await member.joinGroup(mainDeviceName);
              this.platform.log.info(`[${member.host}] Took ${Date.now() - then}ms to join group`);
            })(),
            (async () => {
              await adjustVolume(member);
              this.platform.log.info(`[${member.host}] Took ${Date.now() - then}ms to adjust volume`);
            })()
          ])
        }));
      }

      await Promise.all(promises);

      this.platform.log.info('Starting to play GDS.FM...');
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
      this.platform.log.info('Getting device...');
      const device = await this.getDevice();
      this.platform.log.info('Getting all groups...');
      const groups = await device.getAllGroups();
      this.platform.log.info(`Found ${groups.length} groups`);
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
