export const normalizeString = (str: string | null | undefined): string => {
  return (str || '')
    .normalize('NFD') // Decompõe acentos
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .replace(/[^a-zA-Z0-9\s]/g, '') // Remove caracteres especiais
    .replace(/\s+/g, ' ') // Remove espaços duplicados
    .trim() // Remove espaços nas pontas
    .toUpperCase(); // DB salva em maiúsculo, busca deve ser em maiúsculo
};
