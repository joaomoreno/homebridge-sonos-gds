import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ExampleHomebridgePlatform } from './platform';
import { AsyncDeviceDiscovery, Sonos } from 'sonos';

function getGroupMembers(group: any): Sonos[] {
  return group.ZoneGroupMember.map((member: any) => new Sonos(member.Location.match(/(?<=http:\/\/)(.*?)(?=:\d+)/)[0], undefined, undefined));
}

async function adjustVolume(device: Sonos): Promise<void> {
  const name = await device.getName();
  await device.setVolume(name === 'Sonos Roam' ? 2 : 1);
}

function flatten<T>(array: T[][]): T[] {
  return array.reduce((acc, val) => acc.concat(val), []);
}

export class ExamplePlatformAccessory {

  private service: Service;

  constructor(
    private readonly platform: ExampleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Lightbulb) || this.accessory.addService(this.platform.Service.Lightbulb);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'GDS.FM');

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))                // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this));               // GET - bind to the `getOn` method below
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(value: CharacteristicValue) {
    this.platform.log.info('Set Characteristic On ->', value);

    const discovery = new AsyncDeviceDiscovery();
    const discoveryResult = await discovery.discover();
    const device = discoveryResult.device;
    const groups = await device.getAllGroups();

    if (groups.length === 0) {
      this.platform.log.warn('Found no Sonos devices');
      return false;
    }

    if (value) {
      const [mainGroup, ...otherGroups] = groups;
      const mainDevice = mainGroup.CoordinatorDevice() as Sonos;
      const mainDeviceName = await mainDevice.getName();

      const mainMembers = getGroupMembers(mainGroup);
      const otherMembers = flatten(otherGroups.map(group => getGroupMembers(group)));

      await Promise.all([
        ...mainMembers.map(member => adjustVolume(member)),
        ...otherMembers.map(member => Promise.all([
          member.joinGroup(mainDeviceName),
          adjustVolume(member)
        ]))
      ]);

      await mainDevice.playTuneinRadio('s218325', 'GDS.FM');
      this.platform.log.info('Started playing GDS.FM');
    } else {
      const groupDevices = groups.map<Sonos>(group => group.CoordinatorDevice());
      await Promise.all(groupDevices.map(g => g.stop()));
      this.platform.log.info('Stopped playing Sonos');
    }
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    const discovery = new AsyncDeviceDiscovery();
    const discoveryResult = await discovery.discover();
    const device = discoveryResult.device;
    const groups = await device.getAllGroups();
    const groupDevices = groups.map<Sonos>(group => group.CoordinatorDevice());
    const states = await Promise.all(groupDevices.map(g => g.getCurrentState()));
    const result = states.some(state => state === 'playing');

    this.platform.log.info('Get Characteristic On ->', result);

    return result;
  }
}
