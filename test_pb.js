import 'dotenv/config';
import PocketBase from 'pocketbase';

const pb = new PocketBase(process.env.VITE_DB_ADDRESS);
async function run() {
  await pb.admins.authWithPassword(process.env.VITE_DB_LOGIN, process.env.VITE_DB_PASSWORD);
  const coll = await pb.collections.getOne('buscapac53_pacientes');
  console.log(coll.id);
  console.log(coll.indexes);
}
run();