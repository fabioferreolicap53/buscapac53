import 'dotenv/config';
import PocketBase from 'pocketbase';

const pb = new PocketBase(process.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br');

async function testQuery() {
  try {
    await pb.admins.authWithPassword(process.env.VITE_DB_LOGIN, process.env.VITE_DB_PASSWORD);
    
    const tokens = ["FABIO", "FERREIRA", "OLIVEIRA"];
    const first = tokens[0];
    const nextChar = String.fromCharCode(first.charCodeAt(first.length - 1) + 1);
    const endFirst = first.slice(0, -1) + nextChar;
    
    let filterStr = `(NOME_DA_PESSOA_CADASTRADA >= "${first}" && NOME_DA_PESSOA_CADASTRADA < "${endFirst}")`;
    for (let i = 1; i < tokens.length; i++) {
      filterStr += ` && (NOME_DA_PESSOA_CADASTRADA ~ "${tokens[i]}")`;
    }
    
    console.log('Testing hybrid filter:', filterStr);
    
    const start = Date.now();
    const result = await pb.send('/api/collections/buscapac53_pacientes/records', {
      method: 'GET',
      params: {
        filter: filterStr,
        sort: 'NOME_DA_MAE_PESSOA_CADASTRADA,-DATA_ULTIMA_ATUALIZACAO_DO_CADASTRO',
        perPage: 200
      }
    });
    console.log('Time taken:', Date.now() - start, 'ms');
    
    console.log('Success. Found:', result.items.length);
  } catch (e) {
    console.error('Error Status:', e.status);
    console.error('Error Data:', JSON.stringify(e.response, null, 2));
  }
}
testQuery();