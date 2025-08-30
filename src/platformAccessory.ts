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

      const mainGroup = groups[0];
      const mainDevice = mainGroup.CoordinatorDevice() as Sonos;
      const mainDeviceName = await mainDevice.getName();
      this.platform.log.info(`Group main device name: ${mainDevice}`);

      if (!mainGroup || !mainDevice || !mainDeviceName) {
        this.platform.log.warn('Could not find main device');
        return;
      }

      const otherGroups = groups.filter(group => group !== mainGroup);
      const mainMembers = getGroupMembers(mainGroup);

      const promises: Promise<any>[] = mainMembers.map(async (member, index) => {
        const then = Date.now();
        await adjustVolume(member);
        this.platform.log.info(`[${member.host}] Took ${Date.now() - then}ms to adjust volume`);
      });

      const otherMembers = flatten(otherGroups.map(group => getGroupMembers(group)));
      const otherMemberNames = await Promise.all(otherMembers.map(member => member.getName()));

      this.platform.log.info(`Found ${otherMembers.length} other members: ${otherMemberNames.join(', ')}`);

      if (otherMembers.length > 0) {
        promises.push(...otherMembers.map(async member => {
          const then = Date.now();

          await Promise.all([
            (async () => {
              await member.joinGroup(mainDeviceName!);
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

  private async getSonosRoam(): Promise<{ device: Sonos, groupMembers: Sonos[] } | undefined> {
    const device = await this.getDevice();
    const groups = await device.getAllGroups();

    for (const group of groups) {
      const groupMembers = getGroupMembers(group);

      for (const device of groupMembers) {
        if ((await device.getName()) === 'Sonos Roam') {
          return { device, groupMembers };
        }
      }
    }

    return undefined;
  }

  async getSleepGuiStatus() {
    const result = await this.getSonosRoam();

    if (!result) {
      this.platform.log.warn('Could not find Sonos Roam');
      return false;
    }

    const { device, groupMembers } = result;
    const state = await device.getCurrentState();

    if (state !== 'playing' || groupMembers.length !== 1) {
      return false;
    }

    const track = await device.currentTrack();

    this.platform.log.info(track);
    this.platform.log.info(await device.getQueue());

    if (track.uri !== 'x-sonos-spotify:spotify%3atrack%3a2xtXF7ryBdtqcJxLw7ibK8?sid=9&flags=8232&sn=2') {
      return false;
    }

    return true;
  }

  async toggleSleepGui(shouldPlay: boolean) {
    const result = await this.getSonosRoam();

    if (!result) {
      this.platform.log.warn('Could not find Sonos Roam');
      return;
    }

    const { device } = result;

    if (!shouldPlay) {
      await device.pause();
      return;
    }

    await device.becomeCoordinatorOfStandaloneGroup();
    await device.setVolume(10);
    await device.flush();
    // await device.setPlayMode('REPEAT_ONE');
    await device.queue('spotify:track:2xtXF7ryBdtqcJxLw7ibK8');
  }
}

export class GDSFM {

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

export class SleepGui {

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

    this.service.setCharacteristic(this.platform.Characteristic.Name, '😴 Guid');
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet((value) => this.controller.toggleSleepGui(!!value))
      .onGet(() => this.controller.getSleepGuiStatus());
  }
}
