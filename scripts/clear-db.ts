import PocketBase from 'pocketbase';
import 'dotenv/config';

const pb = new PocketBase(process.env.VITE_DB_ADDRESS || 'https://centraldedados.dev.br');
const PATIENTS_COLLECTION = 'buscapac53_pacientes';

async function clear() {
  const email = process.env.VITE_DB_LOGIN;
  const password = process.env.VITE_DB_PASSWORD;

  if (!email || !password) {
    console.error('ERRO: Credenciais VITE_DB_LOGIN/VITE_DB_PASSWORD não encontradas no .env');
    process.exit(1);
  }

  try {
    console.log(`Conectando em ${pb.baseUrl}...`);
    await pb.admins.authWithPassword(email, password);
    console.log('Autenticado como admin.');

    console.log(`Limpando coleção ${PATIENTS_COLLECTION} de uma só vez...`);
    
    try {
      // Tenta o endpoint de truncate (mais rápido)
      await pb.send(`/api/collections/${encodeURIComponent(PATIENTS_COLLECTION)}/truncate`, {
        method: 'DELETE'
      });
      console.log('SUCESSO: Coleção truncada via API.');
    } catch (e) {
      console.warn('AVISO: Truncate via API falhou ou não suportado. Tentando recriação atômica...');
      
      const collection = await pb.collections.getOne(PATIENTS_COLLECTION);
      
      // Clone da coleção sem IDs de sistema
      const collectionClone = {
        name: collection.name,
        type: collection.type,
        schema: collection.schema,
        listRule: collection.listRule,
        viewRule: collection.viewRule,
        createRule: collection.createRule,
        updateRule: collection.updateRule,
        deleteRule: collection.deleteRule,
        indexes: collection.indexes,
        options: collection.options,
        system: false
      };

      await pb.collections.delete(collection.id);
      console.log('Coleção antiga removida.');
      
      await pb.collections.create(collectionClone);
      console.log('SUCESSO: Coleção recriada e vazia.');
    }

    console.log('Limpeza concluída com sucesso.');
    process.exit(0);
  } catch (error: any) {
    console.error('ERRO FATAL:', error.message || error);
    process.exit(1);
  }
}

clear();
