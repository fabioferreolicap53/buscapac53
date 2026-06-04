import 'dotenv/config';
import PocketBase from 'pocketbase';

const pb = new PocketBase(process.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br');

async function testQuery() {
  try {
    await pb.admins.authWithPassword(process.env.VITE_DB_LOGIN, process.env.VITE_DB_PASSWORD);
    
    const filterStr = `(NOME_DA_PESSOA_CADASTRADA ~ "FABIO") && (NOME_DA_PESSOA_CADASTRADA ~ "FERREIRA") && (NOME_DA_PESSOA_CADASTRADA ~ "OLIVEIRA")`;
    console.log('Testing filter:', filterStr);
    
    const records = await pb.collection('buscapac53_pacientes').getList(1, 10, {
      filter: filterStr,
      $autoCancel: false
    });
    
    console.log('Success. Found:', records.items.length);
  } catch (e) {
    console.error('Error Status:', e.status);
    console.error('Error Data:', JSON.stringify(e.response, null, 2));
  }
}
testQuery();
