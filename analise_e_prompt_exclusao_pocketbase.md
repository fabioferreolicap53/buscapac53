# Análise Completa e Prompt - Sistema de Exclusão em Massa PocketBase + React

## Análise do Sistema de Exclusão de Registros

### Arquitetura Geral

O sistema de exclusão em massa da coleção `amarcap53_pacientes` do PocketBase é implementado inteiramente no frontend, sem dependência de hooks customizados do servidor (`pb_hooks`). A decisão de não usar backend foi tomada porque a versão do PocketBase em produção (v0.39.4) apresentou incompatibilidades com a API `$app.dao()` nos hooks JS.

O fluxo envolve:
- **React 18 + TypeScript** no componente `SettingsScreen.tsx`
- **PocketBase JS SDK** para busca de IDs e deleção em lote
- **fetch() REST** para validação de senha (evitando efeitos colaterais no authStore)
- **Tailwind CSS** para estilização
- **framer-motion** para animações de transição

---

## 1. O Que Funciona Corretamente

### 1.1 Validação de Senha sem Efeito Colateral no AuthStore

A descoberta mais crítica deste desenvolvimento: o método `pb.collection('users').authWithPassword()` do SDK PocketBase **modifica o `pb.authStore` internamente**, o que dispara o listener `onChange`. O AuthContext do React escuta esse evento e, ao detectar mudança no token, reage como se o usuário tivesse trocado — corrompendo a sessão e forçando logout.

**Solução correta**: usar `fetch()` REST direto para o endpoint `POST /api/collections/{collection}/auth-with-password`. Isso retorna o token no corpo da resposta sem alterar nada no authStore.

```typescript
// CERTO: não modifica authStore
var resp = await fetch(pb.baseURL + '/api/collections/amarcap53_users/auth-with-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identity, password }),
});
var data = await resp.json();

// ERRADO: modifica authStore → dispara onChange → desloga usuário
await pb.collection('amarcap53_users').authWithPassword(identity, password);
```

### 1.2 Extração Robusta de Identity do Usuário

Três níveis de fallback para obter o identity (email/username):
1. `user?.email || user?.username` do model React
2. Decodificação manual do JWT: `atob(authStore.token.split('.')[1])` → extrai `payload.email || payload.username`
3. fallback vazio (tratado como erro)

Isso cobre cenários onde o `user` do AuthContext não está populado.

### 1.3 Verificação de Role no Servidor

A role é extraída de `data.record.role` retornado pelo endpoint de autenticação, não do `user` local. Isso garante que a verificação é feita contra o dado mais recente do servidor.

### 1.4 Uso Correto de useRef para Controle de Fluxo Assíncrono

O loop de deleção usa `deleteFlagsRef` (um `useRef`) para as flags `paused` e `cancelled`. Esta é a **única abordagem correta** para controle de fluxo dentro de loops assíncronos em React:

- **useState falharia**: o closure do `for` + `await` capturaria o valor serializado no momento da renderização, ignorando mudanças posteriores.
- **useRef funciona**: a ref é um objeto mutável, acessado por referência. O loop sempre lê o valor atual.

### 1.5 Exclusão em Lotes com Promise.allSettled

- Lotes de 100 registros com `Promise.allSettled` (não `Promise.all`) — falhas individuais não abortam o lote
- `requestKey: null` previne conflitos de cache de requisição do PocketBase SDK
- Contagem separada de `fulfilled` vs `rejected` para métricas precisas

### 1.6 Feedback Visual Rico

- **Durante a exclusão**: barra de progresso com gradiente, cronômetro ao vivo, contagem de erros, ETA estimado, indicador de pausado vs executando
- **Ao completar**: métricas finais (registros, duração, falhas), visual diferenciado para operação completa vs interrompida (ícone verde vs âmbar)
- **Em caso de erro**: destaque rosa com mensagem do erro

### 1.7 Modal de Senha com Design Profissional

- Overlay com backdrop blur
- Card com animação spring (escala + opacidade + translação)
- Elementos decorativos sutis (círculos com blur)
- Ícone Shield com gradiente
- Input com toggle de visibilidade (olho)
- Mensagens de erro animadas
- Fechamento ao clicar no backdrop

### 1.8 Controles de Pausa/Continue/Interromper

- Três estados: `running`, `paused`, `idle`
- Botão único que alterna entre "⏸ Pausar" e "▶ Continuar"
- Botão separado "⏹ Interromper"
- Pausa via `while` loop com `setTimeout(200ms)` — polling leve sem travar a thread

---

## 2. O Que Não Funciona ou Tem Riscos

### 2.1 RISCO CRÍTICO: Timeout no getFullList sem Limite

```typescript
const records = await pb.collection('amarcap53_pacientes').getFullList({ fields: 'id' });
```

**Problema**: `getFullList()` sem parâmetro de paginação busca TODOS os registros de uma vez. Para coleções com >100.000 registros, o navegador pode:
- Estourar timeout da requisição (30s padrão do fetch)
- Consumir memória excessiva com o array de IDs
- O próprio PocketBase pode recusar a requisição

**Solução alternativa**: usar `getList()` em loop paginado:
```typescript
let allIds: string[] = [];
let page = 1;
const perPage = 10000;
while (true) {
  const list = await pb.collection('pacientes').getList(page, perPage, { fields: 'id' });
  allIds.push(...list.items.map(r => r.id));
  if (list.totalItems <= page * perPage) break;
  page++;
}
```

### 2.2 RISCO ALTO: Perda de Sessão se AuthStore Mudar Durante Exclusão

Se o usuário abrir outra aba e deslogar (por exemplo, expiração de token), ou se o AuthContext atualizar o `pb` instance, as requisições de deleção subsequentes falharão com 401.

**Solução parcial**: capturar erro 401 e mostrar mensagem "Sessão expirada. Faça login novamente."

### 2.3 RISCO MÉDIO: Abandono ao Navegar para Outra Rota

Se o usuário navegar para outra página durante a exclusão:
- O componente `SettingsScreen` desmonta
- O loop assíncrono continua rodando em background (sem callback)
- As chamadas `setDeleteStatus`, `setDeleteProgress` etc. disparam em componente desmontado (React warning)
- O usuário perde o feedback visual

**Solução possível**: usar `isMounted` ref + cancelar via `AbortController` + cleanup no `useEffect` return.

### 2.4 RISCO MÉDIO: ETA Usa useState Dentro de setInterval

```typescript
deleteEtaTimerRef.current = setInterval(() => {
  var p = deleteProgress;  // ← valor stale!
  ...
}, 2000);
```

`deleteProgress` capturado no closure do `setInterval` é o valor do momento em que o intervalo foi criado, não o valor atualizado. O ETA calculado será impreciso.

**Solução**: usar variáveis locais no escopo da função em vez de depender do state dentro do intervalo, ou usar `useRef` para as métricas de progresso.

### 2.5 BAIXO: Campo de Senha sem Validação de Requisitos Mínimos

- Sem validação de comprimento mínimo
- Sem prevenção de submissão múltipla (double-click no Confirmar)
- Sem bloqueio após N tentativas falhas

### 2.6 BAIXO: Sem Log de Auditoria

A exclusão é registrada apenas visualmente no frontend. Não há:
- Registro de "quem excluiu quando" no PocketBase
- Histórico auditável da operação

### 2.7 MÉDIO: Número Mágico para Tamanho do Lote

`BATCH = 100` é fixo. Para bases muito pequenas (<100 registros), o lote único funciona. Para bases muito grandes, 100 requisições paralelas podem sobrecarregar o servidor. Um tamanho adaptativo ou configurável seria mais robusto.

---

## 3. Decisões de Arquitetura e Seus Impactos

| Decisão | Impacto Positivo | Impacto Negativo |
|---|---|---|
| Exclusão inteiramente no frontend | Simples, sem deploy de hook | Dependente de rede, sem transação atômica |
| fetch REST para validar senha | AuthStore intacto, sem logout | Duas chamadas auth (login + validação) |
| useRef para pause/cancel | Loop reativo sem re-render | Mais complexo de debugar |
| Promise.allSettled | Falha parcial não quebra lote | Erros individuais não são tratados |
| getFullList sem paginação | Código mais simples | Timeout em bases grandes |
| Animação spring no modal | UX premium | Dependência de framer-motion |

---

## Prompt Detalhado para Projetos Futuros

---

## Contexto

Implemente um sistema de exclusão em massa de registros em uma coleção PocketBase, acessível via uma tela de configurações/admin. O sistema deve conter:

1. Card de ação com botão "Excluir Tudo"
2. Modal de confirmação de senha com design moderno
3. Validação de senha sem afetar a sessão do usuário
4. Exclusão em lotes com barra de progresso
5. Controles de pausar, continuar e interromper
6. Métricas em tempo real (tempo, erros, ETA)
7. Resumo final diferenciado (completo vs interrompido)

## Stack Tecnológica

- React 18+ com TypeScript (Vite)
- Tailwind CSS para estilização
- framer-motion para animações
- lucide-react para ícones
- PocketBase JS SDK (pocketbase)
- Autenticação via AuthContext que observa pb.authStore.onChange

## Esquema das Coleções PocketBase

- **{collection_name}_pacientes**: coleção alvo para exclusão (mínimo: campo `id`)
- **{collection_name}_users**: coleção de usuários com campos `email`, `username`, `role`
- Roles com permissão: 'cap' e 'admin'

## Requisitos Detalhados

### 1. Card de Exclusão (Estado Inicial)

- Background branco, cantos arredondados `rounded-[2.5rem]`, sombra suave
- Ícone `Trash2` da lucide-react, tamanho w-8 h-8, cor rose-500
- Título em uppercase tracking-tight, label descritiva em tracking-widest
- Texto explicativo: "Esta ação remove permanentemente todos os dados da coleção."
- Botão "Excluir Tudo" em rose-600 com hover rose-700, tracking-widest, rounded-2xl
- Clique abre modal de senha (NÃO inicia exclusão ainda)

### 2. Modal de Confirmação de Senha

**Estrutura:**
- Overlay: fixed inset-0, z-[9999], flex items-center justify-center, bg-black/60 com backdrop-blur-sm
- Fechar ao clicar no backdrop (onClick no overlay)
- Card central: max-w-md, bg-white shadow-2xl, border-rose-100, rounded-[2.5rem], p-8

**Decoração:**
- Dois círculos decorativos com bg-rose-500/5 e blur-3xl nos cantos (absolute, top-right e bottom-left)

**Header:**
- Ícone Shield (w-14 h-14) com gradiente from-rose-500 to-rose-700, rounded-2xl
- Título "Confirmação de Segurança", label "Ação irreversível" em rose-500

**Aviso:**
- bg-rose-50, border-rose-200, p-4, rounded-2xl
- Texto: "Esta ação irá remover permanentemente TODOS os registros da coleção. Esta operação não pode ser desfeita."

**Input de Senha:**
- Label "Digite sua senha para confirmar" em text-[10px] uppercase tracking-[0.2em]
- Input container: relative com o input + botão de olho
- Input: w-full, py-4, pl-11 (espaço para o ícone), pr-5, bg-slate-50, border-2 border-slate-200, rounded-2xl
- Alterna type entre 'password' e 'text' conforme estado showPassword
- Botão do olho: absolute left-3.5 top-1/2 -translate-y-1/2, SVG inline strokeWidth 2.5
- Dois SVGs: olho aberto (path + circle) e olho fechado (path + line)
- Placeholder: "••••••••"
- autoFocus no input
- Enter no input dispara submit (onKeyDown)
- Mensagem de erro animada com framer-motion se senha incorreta

**Botões:**
- "Cancelar": bg-slate-100, text-slate-600, tracking-widest, rounded-2xl, py-4
- "Confirmar": bg-gradient-to-r from-rose-600 to-rose-700, text-white, shadow-lg shadow-rose-200

**Animações:**
- Overlay: AnimatePresence, fade in/out (opacity 0→1)
- Card: spring animation com scale 0.9→1, opacity 0→1, y 20→0, duration 0.5s
- Erro: motion.p com opacity 0→1, y -4→0

### 3. Validação de Senha (CRÍTICO)

**IMPORTANTE:** NUNCA usar `pb.collection('users').authWithPassword()` para validar senha neste contexto. Este método modifica `pb.authStore`, que dispara o listener `onChange`. O AuthContext que observa este evento detectará a mudança e deslogará o usuário.

Sempre usar `fetch()` REST direto:

```typescript
var identity = user?.email || user?.username || '';
if (!identity) {
  // Fallback: decodificar token JWT
  try {
    var payload = JSON.parse(atob(pb.authStore.token.split('.')[1]));
    identity = payload.email || payload.username || '';
  } catch {}
}

var resp = await fetch(pb.baseURL + '/api/collections/amarcap53_users/auth-with-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identity, password }),
});
var data = await resp.json();
if (!resp.ok || !data.token) {
  setPasswordError('Senha incorreta');
  return;
}
if (data.record?.role !== 'cap' && data.record?.role !== 'admin') {
  setPasswordError('Apenas usuários CAP ou admin podem excluir dados');
  return;
}
```

**Proteções adicionais:**
- Input vazio: "Digite sua senha"
- Falha de rede: "Erro ao validar senha"
- role inválida: bloqueia com mensagem específica

### 4. Exclusão em Lotes com Controles

**Antes de iniciar:**
- Fechar modal
- Resetar estados de resumo, ETA, progresso
- setIsDeleting(true), setDeleteControl('running')
- Marcar timestamp de início (Date.now())
- Iniciar setInterval para ETA (a cada 2s)

**Busca de IDs:**
```typescript
const records = await pb.collection('amarcap53_pacientes').getFullList({ fields: 'id' });
```
⚠️ Para bases >100k registros, substituir por `getList` paginado.

**Loop de deleção:**
```typescript
var BATCH = 100;
for (var i = 0; i < total; i += BATCH) {
  // Verificar cancelamento
  if (deleteFlagsRef.current.cancelled) break;
  
  // Esperar se pausado (polling a cada 200ms)
  while (deleteFlagsRef.current.paused && !deleteFlagsRef.current.cancelled) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (deleteFlagsRef.current.cancelled) break;

  var batch = records.slice(i, i + BATCH);
  var results = await Promise.allSettled(
    batch.map(r => pb.collection('amarcap53_pacientes').delete(r.id, { requestKey: null }))
  );
  // Contar acertos e erros
  results.forEach(r => r.status === 'fulfilled' ? deleted++ : errorsCount++);
  setDeleteProgress({ deleted, total, errors: errorsCount });
}
```

**Ao finalizar:**
- Limpar intervalo de ETA
- Calcular elapsed = Date.now() - startTime
- Diferenciar: cancelled ? "interrompida" : "com sucesso"
- Salvar em deleteSummary: { elapsedSec, errors, total, cancelled }
- fetchStats() para atualizar contadores

**Tratamento de erro:**
- Catch geral no try principal
- Limpar intervalo de ETA
- Salvar erro em deleteSummary
- Exibir "Erro: {mensagem}" no estado error

### 5. Estados Gerenciados

```typescript
// Controle da exclusão
const [isDeleting, setIsDeleting] = useState(false);
const [deleteStatus, setDeleteStatus] = useState<{ message: string; type: 'idle' | 'deleting' | 'completed' | 'error' }>({ message: '', type: 'idle' });
const [deleteControl, setDeleteControl] = useState<'idle' | 'running' | 'paused'>('idle');

// Modal de senha
const [showPasswordModal, setShowPasswordModal] = useState(false);
const [passwordInput, setPasswordInput] = useState('');
const [passwordError, setPasswordError] = useState('');
const [showPassword, setShowPassword] = useState(false);

// Métricas
const [deleteProgress, setDeleteProgress] = useState({ deleted: 0, total: 0, errors: 0 });
const [deleteSummary, setDeleteSummary] = useState<{ elapsedSec: number; errors: number; total: number; cancelled: boolean } | null>(null);
const [deleteEta, setDeleteEta] = useState<string>('');

// Refs para controle assíncrono (useRef, NÃO useState)
const deleteFlagsRef = useRef({ paused: false, cancelled: false });
const deleteStartTimeRef = useRef(0);
const deleteEtaTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
```

### 6. UI de Progresso (Estado 'deleting')

**Barra de progresso:**
- Duas linhas: contador "X / Y registros" + percentual
- h-3 bg-rose-100 rounded-full com motion.div animado (gradiente from-rose-500 to-rose-600)
- Largura animada: `(deleted / total) * 100%`

**Grid de métricas (3 colunas):**
1. TEMPO: cronômetro ao vivo calculado via `Date.now() - deleteStartTimeRef.current` → "Xm YYs"
2. ERROS: número (text-emerald-600 se 0, text-rose-600 se >0)
3. ESTIMADO/RESTANTE: ETA calculado via taxa (rate = deleted / elapsed), exibindo "Xm YYs"

**Status:**
- Loader2 animate-spin (rose-500) se running
- div w-3 h-3 bg-amber-400 animate-pulse se paused
- Label: "EXCLUINDO" ou "PAUSADO"

**Controles (flex gap-3):**
- Botão "⏸ Pausar" / "▶ Continuar": bg-amber-500, tracking-widest, rounded-2xl, text-xs
- Botão "⏹ Interromper": bg-slate-200, text-slate-600

### 7. UI de Resultado (Estado 'completed' com deleteSummary)

**Header (diferenciado por cancelled):**
- Se cancelled=false: bg-emerald-50, border-emerald-100, ícone CheckCircle bg-emerald-500
- Se cancelled=true: bg-amber-50, border-amber-200, ícone AlertTriangle bg-amber-500
- Mensagem correspondente

**Grid de métricas finais (3 colunas):**
1. REGISTROS: total excluídos
2. DURAÇÃO: elapsedSec convertido para "Xm YYs"
3. FALHAS: número (bg-rose-50 se >0, bg-slate-50 se 0, text-rose-600 se >0)

**Botão "Voltar":** bg-slate-100, reseta todos os estados de exclusão (type='idle', control='idle', summary=null)

### 8. UI de Erro (Estado 'error')

Mesma estrutura do resultado, mas:
- bg-rose-50, border-rose-100
- Ícone AlertTriangle bg-rose-500
- Mensagem: "Erro: {mensagem}"
- Botão "Voltar"

## Observações de Segurança

1. A validação de senha é uma camada de UX, não de segurança backend. As regras reais de segurança devem estar no PocketBase (deleteRule da coleção)
2. NUNCA armazenar a senha em estado ou ref após a validação
3. Para ambientes críticos, considerar mover a exclusão para um endpoint customizado server-side com verificação de senha e registro de auditoria
4. O identity extraído do JWT pode ser manipulado? Não, pois o JWT é assinado pelo servidor. A decodificação é apenas para leitura dos claims, não para validação

## Padrões e Convenções de Código

- usar `var` em vez de `const`/`let` para variáveis dentro do handler (consistente com PocketBase JS hooks, mas opcional)
- Comentários em português para o time
- Nomes de funções em camelCase, handlers com prefixo `handle`
- Estados tipados strictamente (não usar `any` para estados)
- Refs tipados com `useRef<Type>`
- Animações com framer-motion, não CSS transitions para elementos condicionais
