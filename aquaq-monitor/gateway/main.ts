// Gateway entry point:
//   MQTT_URL=mqtts://broker:8883 MQTT_USERNAME=… MQTT_PASSWORD=… \
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… BOAT_IDS=B1 npm run gateway
import mqtt from 'mqtt';
import { createClient } from '@supabase/supabase-js';
import { Bridge } from './bridge.ts';
import { SupabaseStore } from './supabaseStore.ts';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Set ${k}`);
  return v;
};

const db = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const client = await mqtt.connectAsync(need('MQTT_URL'), {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId: `aquaq-gateway-${process.pid}`,
  clean: false, // keep QoS 1 messages across reconnects
});
const bridge = new Bridge(client, new SupabaseStore(db), { boatIds: (process.env.BOAT_IDS ?? 'B1').split(',').map((s) => s.trim()) });
await bridge.start();
process.on('SIGINT', () => {
  bridge.stop();
  void client.endAsync().then(() => process.exit(0));
});
