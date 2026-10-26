// Boat + station emulator for the demo lake, speaking the gateway's MQTT protocol:
//   MQTT_URL=mqtt://localhost:1883 npm run boat-emulator
import mqtt from 'mqtt';
import { demoBoat, demoParameters, demoSensors, demoStations, demoWaterBody, demoZones } from '../supabase/functions/_shared/demoLake.ts';
import { DEFAULT_SETTINGS } from '../supabase/functions/_shared/types.ts';
import { BoatEmulator } from './emulator.ts';

const now = Date.now();
const iso = new Date(now).toISOString();
const client = await mqtt.connectAsync(process.env.MQTT_URL ?? 'mqtt://localhost:1883', { clientId: `aquaq-boat-emulator-${process.pid}` });
const world = { waterBody: demoWaterBody(), zones: demoZones(), parameters: demoParameters(), stations: demoStations(iso), sensors: demoSensors(now), settings: DEFAULT_SETTINGS };
const emu = new BoatEmulator(client, world, { ...demoBoat(iso), mode: 'IDLE' });
await emu.start();
console.log(`[emulator] boat ${emu.boatId} idle at the dock; waiting for commands`);
