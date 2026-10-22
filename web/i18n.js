// UI strings. Locale: saved choice, else the system language (pt* → pt, anything else → en).
const STRINGS = {
  en: {
    loading: "loading…",
    tabPending: "Pending", tabDone: "Done", tabInsights: "Insights",
    filterPlaceholder: "Filter by title, project, prompt, note…", filter: "Filter", project: "Project", allProjects: "All projects",
    openOnly: "Open only", suggestedOnly: "With suggestion",
    failed: "Failed: {msg}", serverDown: "server unavailable: {msg}",
    today: "today", yesterday: "yesterday", daysAgo: "{n}d ago",
    emptyPending: "Nothing pending. New sessions show up here on their own.", emptyDone: "Nothing done yet.",
    counts: "{pending} pending · {suggested} suggested · {untriaged} untriaged · {live} open · {done} done",
    statusTodo: "To resume", statusDoing: "In progress", statusDone: "Done", status: "Status",
    goToTab: "Go to tab", resume: "Resume", close: "Close", confirmClose: "Confirm close", sessionClosed: "Session closed",
    opening: "Opening…", closing: "Closing…",
    notePlaceholder: "Note: where I stopped, next step…",
    active: "active {ago}", open: "● open {tty}", isNew: "new", onlyBackup: "backup only", transcriptGone: "transcript gone", backupOk: "backup ✓",
    looksDone: "Looks done ({pct}%)", quoteNotFound: " (quote not found in your messages)", confirmDone: "Confirm done", dismiss: "Dismiss", doneToast: "Done",
    markedByHaiku: "Marked by Haiku ({pct}%)", wrongReopen: " Wrong? Click “To resume”.",
    details: "Details", aiTitle: "Generated title: {v}", firstPrompt: "First prompt: {v}", promptsCwd: "{n} prompts · {cwd}",
    tilePending: "pending ({n} untriaged)", tileLive: "open sessions", tileRam: "RAM of open sessions", tileSwap: "swap in use (RAM {ram})",
    tileTokens: "tokens generated (all)", tileIdleTabs: "idle Terminal tabs",
    tileSuggestions: "suggestions · {auto} auto-marked · {classified} analyzed · US$ {cost}",
    loadFailed: "Failed to load: {msg}", countsShort: "{pending} pending · {live} open · {done} done",
    idleFor: "idle for {h}h: candidate to close",
    age1: "< 1 day", age2: "1–7 days", age3: "7–14 days", age4: "> 14 days",
    weekTip: "week of {start}: {created} new, {done} done",
    colSession: "Session", colProject: "Project", colPrompts: "Prompts", colIn: "Input", colCache: "Cache", colOut: "Output",
    closeIdleTabs: "Close {n} idle tabs", confirm: "Confirm", tabsClosed: "Tabs closed",
    pOpenRam: "Open × RAM", pOpenRamIdle: "{n} idle for 24h+ hold {mb}", pOpenRamSub: "process footprint + MCPs",
    activeLast24: "active in the last 24h", idle24: "◌ idle for 24h+",
    pByProject: "Pending by project and age", pByProjectSub: "age = last activity",
    pPerDay: "Prompts per day", last30: "last 30 days",
    pWeekly: "New × done per week", pWeeklySub: "done = marked by you", newL: "new", doneL: "done", thisWeek: "this week",
    pLongest: "Longest sessions", pLongestSub: "by your prompts", pCostliest: "Costliest sessions", pCostliestSub: "by tokens generated",
    pStorage: "Storage", sTranscripts: "transcripts in ~/.claude", sBackup: "Hangar backup", sNoBackup: "pending without backup", sExpiring: "expire in 30 days",
    expires: "{title} — expires {date}", hasBackup: " (backed up)", noBackup: " (no backup)",
    pIdleTabs: "Idle Terminal tabs", pIdleTabsSub: "shell only, nothing running", none: "none",
    language: "Language",
  },
  pt: {
    loading: "carregando…",
    tabPending: "Pendentes", tabDone: "Concluídas", tabInsights: "Insights",
    filterPlaceholder: "Filtrar por título, projeto, prompt, nota…", filter: "Filtrar", project: "Projeto", allProjects: "Todos os projetos",
    openOnly: "Só abertas", suggestedOnly: "Só com sugestão",
    failed: "Falhou: {msg}", serverDown: "servidor fora: {msg}",
    today: "hoje", yesterday: "ontem", daysAgo: "{n}d atrás",
    emptyPending: "Nada pendente. Sessões novas aparecem aqui sozinhas.", emptyDone: "Nada concluído ainda.",
    counts: "{pending} pendentes · {suggested} com sugestão · {untriaged} sem triagem · {live} abertas · {done} concluídas",
    statusTodo: "A retomar", statusDoing: "Em curso", statusDone: "Concluída", status: "Status",
    goToTab: "Ir para aba", resume: "Retomar", close: "Encerrar", confirmClose: "Confirmar encerrar", sessionClosed: "Sessão encerrada",
    opening: "Abrindo…", closing: "Encerrando…",
    notePlaceholder: "Nota: onde parei, próximo passo…",
    active: "ativa {ago}", open: "● aberta {tty}", isNew: "nova", onlyBackup: "só no backup", transcriptGone: "transcript sumiu", backupOk: "backup ✓",
    looksDone: "Parece concluída ({pct}%)", quoteNotFound: " (citação não encontrada nas suas mensagens)", confirmDone: "Confirmar concluída", dismiss: "Descartar", doneToast: "Concluída",
    markedByHaiku: "Marcada pelo Haiku ({pct}%)", wrongReopen: " Errado? Clique em “A retomar”.",
    details: "Detalhes", aiTitle: "Título gerado: {v}", firstPrompt: "Primeiro prompt: {v}", promptsCwd: "{n} prompts · {cwd}",
    tilePending: "pendentes ({n} sem triagem)", tileLive: "sessões abertas", tileRam: "RAM das abertas", tileSwap: "swap em uso (RAM {ram})",
    tileTokens: "tokens gerados (todas)", tileIdleTabs: "abas do Terminal ociosas",
    tileSuggestions: "sugestões · {auto} marcadas sozinhas · {classified} analisadas · US$ {cost}",
    loadFailed: "Falha ao carregar: {msg}", countsShort: "{pending} pendentes · {live} abertas · {done} concluídas",
    idleFor: "parada há {h}h: candidata a encerrar",
    age1: "< 1 dia", age2: "1–7 dias", age3: "7–14 dias", age4: "> 14 dias",
    weekTip: "semana de {start}: {created} novas, {done} concluídas",
    colSession: "Sessão", colProject: "Projeto", colPrompts: "Prompts", colIn: "Entrada", colCache: "Cache", colOut: "Saída",
    closeIdleTabs: "Fechar {n} abas ociosas", confirm: "Confirmar", tabsClosed: "Abas fechadas",
    pOpenRam: "Abertas × RAM", pOpenRamIdle: "{n} paradas há 24h+ seguram {mb}", pOpenRamSub: "footprint do processo + MCPs",
    activeLast24: "ativa nas últimas 24h", idle24: "◌ parada há 24h+",
    pByProject: "Pendentes por projeto e idade", pByProjectSub: "idade = última atividade",
    pPerDay: "Prompts por dia", last30: "últimos 30 dias",
    pWeekly: "Novas × concluídas por semana", pWeeklySub: "concluídas = marcadas por você", newL: "novas", doneL: "concluídas", thisWeek: "esta semana",
    pLongest: "Sessões mais longas", pLongestSub: "por prompts seus", pCostliest: "Sessões mais caras", pCostliestSub: "por tokens gerados",
    pStorage: "Armazenamento", sTranscripts: "transcripts em ~/.claude", sBackup: "backup do Hangar", sNoBackup: "pendentes sem backup", sExpiring: "expiram em 30 dias",
    expires: "{title} — expira {date}", hasBackup: " (tem backup)", noBackup: " (sem backup)",
    pIdleTabs: "Abas do Terminal ociosas", pIdleTabsSub: "só o shell, nenhum processo rodando", none: "nenhuma",
    language: "Idioma",
  },
};

let LOCALE = (() => {
  try { const saved = localStorage.getItem("locale"); if (STRINGS[saved]) return saved; } catch {}
  return (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt" : "en";
})();
document.documentElement.lang = LOCALE === "pt" ? "pt-BR" : "en";

function t(key, vars = {}) {
  const s = STRINGS[LOCALE][key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function setLocale(l) {
  try { localStorage.setItem("locale", l); } catch {}
  location.reload();
}
