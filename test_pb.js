import 'dotenv/config';
import PocketBase from 'pocketbase';

const pb = new PocketBase(process.env.VITE_DB_ADDRESS);
async function run() {
  // PocketBase v0.23+ usa /api/collections/_superusers (a rota /api/admins foi removida).
  const auth = await pb.send('/api/collections/_superusers/auth-with-password', {
    method: 'POST',
    body: { identity: process.env.VITE_DB_LOGIN, password: process.env.VITE_DB_PASSWORD }
  });
  pb.authStore.save(auth.token, auth.record);
  const coll = await pb.collections.getOne('buscapac53_pacientes');
  console.log(coll.id);
  console.log(coll.indexes);
}
run();