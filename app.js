import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, authRedirectTo } from './js/config.js';
import { canonicalCau, validarRegistroCAU, mensagemErroRegistroCAU, formatCauInput } from './js/cau.js';
import {
  MENSAGEM_CONTEUDO_RETIDO,
  MIN_CHARS,
  MAX_CHARS_POST,
  MAX_CHARS_COMENTARIO,
  motivoRetencao,
} from './js/moderation.js';

const RATE_LIMIT_MS = 30 * 1000;
const RATE_KEY = 'multipla_last_submit_at';
const CONFIG_READY =
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_ANON_KEY) &&
  !SUPABASE_URL.includes('YOUR_PROJECT') &&
  !SUPABASE_ANON_KEY.includes('YOUR_ANON_KEY');

const state = {
  supabase: null,
  user: null,
  profile: null,
  posts: [],
  postsBase: [],
  commentsByPost: new Map(),
  subscriptions: new Map(),
  notifications: [],
  filterType: 'todos',
  sort: 'recentes',
  topicFilter: null,
  searchTerm: '',
};

const els = {
  authSlot: document.getElementById('auth-slot'),
  composeBar: document.getElementById('compose-bar'),
  postForm: document.getElementById('post-form'),
  postFeedback: document.getElementById('post-feedback'),
  feed: document.getElementById('feed'),
  feedEmpty: document.getElementById('feed-empty'),
  feedSearch: document.getElementById('feed-search'),
  searchForm: document.getElementById('search-form'),
  searchClear: document.getElementById('search-clear'),
  searchStatus: document.getElementById('search-status'),
  feedSearchEmpty: document.getElementById('feed-search-empty'),
  searchCreate: document.getElementById('btn-search-create'),
  adminPanel: document.getElementById('admin-panel'),
  reportsList: document.getElementById('reports-list'),
  configBanner: document.getElementById('config-banner'),
  liveRegion: document.getElementById('live-region'),
  shareToast: document.getElementById('share-toast'),
  loginDialog: document.getElementById('login-dialog'),
  loginForm: document.getElementById('login-form'),
  confirmDialog: document.getElementById('confirm-dialog'),
  reportDialog: document.getElementById('report-dialog'),
  cardTemplate: document.getElementById('post-card-template'),
  trendingList: document.getElementById('trending-topics-list'),
  clearTopic: document.getElementById('clear-topic'),
  cauDialog: document.getElementById('cau-dialog'),
  cauForm: document.getElementById('cau-form'),
  cauFeedback: document.getElementById('cau-feedback'),
  lgpdPolicyDialog: document.getElementById('lgpd-policy-dialog'),
  aboutDialog: document.getElementById('about-dialog'),
  composeLock: document.getElementById('compose-lock'),
  ideaBox: document.getElementById('idea-box'),
  fabNewPost: document.getElementById('fab-new-post'),
  headerSearch: document.getElementById('header-search'),
  searchToggle: document.getElementById('search-toggle'),
  moderationAlert: document.getElementById('moderation-alert'),
  notifyWrap: document.getElementById('notify-wrap'),
  notifyBell: document.getElementById('notify-bell'),
  notifyBadge: document.getElementById('notify-badge'),
  notifyMenu: document.getElementById('notify-menu'),
  followDialog: document.getElementById('follow-dialog'),
  accountDialog: document.getElementById('account-dialog'),
};

let cauPromptShown = false;
let cauSaveInFlight = false;
let searchDebounce = null;
let searchSeq = 0;
let composeObserver = null;
let shareToastTimer = null;
let sharedGlowTimer = null;
let sharedHighlightDone = false;
let followTarget = null;
let notifyPoll = null;

function announce(message) {
  els.liveRegion.textContent = message;
}

function isAdmin() {
  return Boolean(state.profile?.is_admin);
}

function hasCauNumber() {
  return Boolean(String(state.profile?.cau_number || '').trim());
}

function lgpdConsentTracked() {
  return Boolean(state.profile) && Object.prototype.hasOwnProperty.call(state.profile, 'lgpd_consent');
}

function hasLgpdConsent() {
  if (!lgpdConsentTracked()) return true;
  return Boolean(state.profile.lgpd_consent);
}

function needsCauRegistration() {
  return Boolean(state.user) && (!hasCauNumber() || !hasLgpdConsent());
}

function syncComposeLock() {
  const locked = needsCauRegistration();
  const form = els.postForm;
  if (!form) return;
  form.querySelectorAll('textarea, select, input, button[type="submit"]').forEach((el) => {
    el.disabled = locked;
  });
  form.setAttribute('aria-disabled', String(locked));
  els.composeLock?.classList.toggle('hidden', !locked);
}

function syncCauFormFromProfile() {
  const cauInput = document.getElementById('cau-number');
  const lgpd = document.getElementById('cau-lgpd');
  if (cauInput && hasCauNumber() && !String(cauInput.value || '').trim()) {
    cauInput.value = formatCauInput(state.profile.cau_number);
  }
  if (lgpd) lgpd.checked = lgpdConsentTracked() && Boolean(state.profile.lgpd_consent);
}

function openCauModal() {
  if (!els.cauDialog) return;
  showFeedback(els.cauFeedback, '');
  syncCauFormFromProfile();
  if (!els.cauDialog.open) els.cauDialog.showModal();
  document.getElementById('cau-number')?.focus();
}

function openAboutDialog(event) {
  event?.preventDefault();
  if (!els.aboutDialog) {
    window.location.href = './sobre.html';
    return;
  }
  if (!els.aboutDialog.open) els.aboutDialog.showModal();
  els.aboutDialog.scrollTop = 0;
}

function openLgpdPolicyDialog(event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!els.lgpdPolicyDialog) {
    window.open('./privacidade.html', '_blank', 'noopener,noreferrer');
    return;
  }
  if (!els.lgpdPolicyDialog.open) els.lgpdPolicyDialog.showModal();
  els.lgpdPolicyDialog.scrollTop = 0;
}

function maybePromptCau() {
  syncComposeLock();
  if (cauSaveInFlight) return;
  if (!needsCauRegistration()) {
    if (els.cauDialog?.open) els.cauDialog.close();
    return;
  }
  if (!cauPromptShown) {
    cauPromptShown = true;
    openCauModal();
  }
}

function mensagemErroPublicar(raw) {
  const text = String(raw || '');
  if (/permission denied/i.test(text) && /profiles/i.test(text)) {
    return 'O banco ainda bloqueia a publicação. Abra o SQL Editor do Supabase e execute sql/fix-posts-insert-cau.sql.';
  }
  if (/row-level security|rls/i.test(text)) {
    return 'Informe e valide o seu registro do CAU para publicar.';
  }
  return text || 'Não foi possível publicar.';
}

function mensagemErroSalvarCau(raw, cau) {
  const text = String(raw || '');
  if (/vinculado a outra conta/i.test(text)) {
    return 'Este registro do CAU já está vinculado a outra conta.';
  }
  if (/PGRST202|schema cache|Could not find the function/i.test(text)) {
    return 'A lista de registros CAU/SC ainda não está no banco. Execute sql/cau-number.sql e sql/cau-sc-ativos.sql no SQL Editor do Supabase.';
  }
  if (/invalido|inválido|nao consta|não consta/i.test(text) || /check constraint/i.test(text)) {
    return 'registro CAU inválido';
  }
  if (/autenticacao obrigatoria/i.test(text)) {
    return 'Sua sessão expirou. Entre novamente com o Google e tente salvar o CAU.';
  }
  if (/nao foi possivel salvar|perfil nao encontrado/i.test(text)) {
    return 'Não foi possível gravar o registro neste perfil. Recarregue a página e tente de novo.';
  }
  if (/timeout|aborted|Failed to fetch|NetworkError/i.test(text)) {
    return 'A conexão com o servidor demorou demais. Verifique a internet e tente novamente.';
  }
  return text || 'Não foi possível salvar o registro do CAU. Tente novamente.';
}

async function rpcComTimeout(fn, ms = 12000) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function persistCauNumber(cau) {
  // CAU + LGPD entram em profiles via set_cau_number (SECURITY DEFINER).
  // Não usamos .from('profiles').update() — isso exigiria GRANT amplo e poderia
  // expor is_admin ou pular a validação na lista oficial de ativos.
  let rpc;
  try {
    rpc = await rpcComTimeout(() => state.supabase.rpc('set_cau_number', { p_cau: cau }));
  } catch (err) {
    throw new Error(err?.message || err?.details || 'timeout');
  }
  if (rpc.error) {
    throw new Error(rpc.error.message || rpc.error.details || 'nao foi possivel salvar o registro CAU');
  }
  const payload = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
  const saved = typeof payload === 'string' || payload == null ? payload : payload.cau_number;
  return { cau_number: saved || cau };
}

async function submitCau(event) {
  event.preventDefault();
  const input = document.getElementById('cau-number');
  const declaration = document.getElementById('cau-declaration');
  const submitBtn = document.getElementById('cau-submit');
  const cau = formatCauInput(input?.value);
  if (input) input.value = cau;

  if (!declaration?.checked) {
    showFeedback(els.cauFeedback, 'Confirme a declaração de arquiteto(a) e urbanista ativo(a) em Santa Catarina.', true);
    return;
  }

  const lgpd = document.getElementById('cau-lgpd');
  if (!lgpd?.checked) {
    showFeedback(
      els.cauFeedback,
      'Você precisa aceitar os termos da LGPD para registrar seu CAU e publicar',
      true,
    );
    return;
  }

  if (!validarRegistroCAU(cau)) {
    showFeedback(els.cauFeedback, mensagemErroRegistroCAU(cau), true);
    return;
  }

  cauSaveInFlight = true;
  if (submitBtn) submitBtn.disabled = true;
  showFeedback(els.cauFeedback, 'Validando e salvando…');
  try {
    const saved = await persistCauNumber(canonicalCau(cau) || cau);
    state.profile = {
      ...(state.profile || {}),
      cau_number: saved.cau_number || canonicalCau(cau) || cau,
      lgpd_consent: true,
      lgpd_consent_at: state.profile?.lgpd_consent_at || new Date().toISOString(),
    };
    showFeedback(els.cauFeedback, 'Registro do CAU validado e salvo.');
    announce('Registro do CAU validado.');
    await loadProfile().catch(() => {});
    try {
      els.cauDialog?.close();
    } catch {
      /* dialog já fechado */
    }
    syncComposeLock();
  } catch (error) {
    showFeedback(els.cauFeedback, mensagemErroSalvarCau(error.message, cau), true);
  } finally {
    cauSaveInFlight = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}

function formatDate(iso) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function remainingRateLimit() {
  const last = Number(localStorage.getItem(RATE_KEY) || 0);
  return last + RATE_LIMIT_MS - Date.now();
}

function assertNotBot(form) {
  const trap = form.querySelector('[name="b_phone_check"]');
  return !trap || !String(trap.value || '').trim();
}

function assertRateLimit() {
  const wait = remainingRateLimit();
  if (wait > 0) {
    const seconds = Math.max(1, Math.ceil(wait / 1000));
    throw new Error(`Aguarde ${seconds}s entre publicações e comentários (proteção anti-spam).`);
  }
}

function hideModerationAlert() {
  els.moderationAlert?.classList.add('hidden');
}

function showModerationAlert() {
  if (!els.moderationAlert) return;
  const text = document.getElementById('moderation-alert-text');
  if (text) text.textContent = MENSAGEM_CONTEUDO_RETIDO;
  els.moderationAlert.classList.remove('hidden');
  announce(MENSAGEM_CONTEUDO_RETIDO);
}

function reterConteudo(feedbackNode, texto, limites) {
  const motivo = motivoRetencao(texto, limites);
  showFeedback(feedbackNode, motivo, true);
  if (motivo === MENSAGEM_CONTEUDO_RETIDO) {
    showModerationAlert();
  } else {
    hideModerationAlert();
  }
}

function markSubmitted() {
  localStorage.setItem(RATE_KEY, String(Date.now()));
}

function showConfigBanner(html) {
  els.configBanner.innerHTML = html;
  els.configBanner.classList.remove('hidden');
}

function showFeedback(node, message, isError = false) {
  if (!node) return;
  node.textContent = message;
  node.className = `text-sm ${isError ? 'feedback-error' : 'feedback-ok'}`;
}

async function confirmAction(title, message) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  els.confirmDialog.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      els.confirmDialog.removeEventListener('close', onClose);
      resolve(els.confirmDialog.returnValue === 'ok');
    };
    els.confirmDialog.addEventListener('close', onClose, { once: true });
  });
}

function openLogin() {
  els.loginDialog.showModal();
}

function renderAuth() {
  if (!CONFIG_READY) {
    els.authSlot.innerHTML = `<span class="meta">Configure o Supabase para entrar</span>`;
    return;
  }

  if (!state.user) {
    els.authSlot.innerHTML = `
      <button type="button" id="btn-login" class="btn btn-primary">
        Entrar com Google
      </button>
    `;
    document.getElementById('btn-login')?.addEventListener('click', openLogin);
    els.composeBar.classList.add('hidden');
    syncComposeLock();
    refreshComposeFab();
    syncNotifyBell();
    return;
  }

  const name = state.profile?.full_name || state.user.user_metadata?.name || 'Arquiteto(a)';
  const avatar = safeHttpUrl(
    state.profile?.avatar_url ||
      state.user.user_metadata?.avatar_url ||
      state.user.user_metadata?.picture ||
      '',
  );
  const adminTag = isAdmin() ? `<span class="admin-tag">Administrador</span>` : '';

  els.authSlot.innerHTML = `
    <div class="flex items-center gap-3">
      ${
        avatar
          ? `<img src="${avatar}" alt="" width="36" height="36" class="avatar" />`
          : ''
      }
      <div class="text-right">
        <p class="user-name">${escapeHtml(name)}</p>
        ${adminTag}
      </div>
      <button type="button" id="btn-account" class="btn btn-ghost">Minha conta</button>
      <button type="button" id="btn-logout" class="btn btn-ghost">Sair</button>
    </div>
  `;
  document.getElementById('btn-logout')?.addEventListener('click', signOut);
  document.getElementById('btn-account')?.addEventListener('click', openAccountSettings);
  els.composeBar.classList.remove('hidden');
  syncComposeLock();
  refreshComposeFab();
  syncNotifyBell();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
  } catch {
    /* ignore */
  }
  return '';
}

async function loadProfile() {
  if (!state.user) {
    state.profile = null;
    return;
  }
  const previousCau = state.profile?.cau_number;
  try {
    const { data, error } = await rpcComTimeout(() => state.supabase.rpc('current_profile'), 10000);
    if (error) throw error;
    const next = Array.isArray(data) ? data[0] : data;
    state.profile = next || state.profile;
    if (!state.profile?.cau_number && previousCau) {
      state.profile = { ...(state.profile || {}), cau_number: previousCau };
    }
  } catch (error) {
    console.warn(error);
    state.profile = {
      id: state.user.id,
      full_name: state.user.user_metadata?.full_name || state.user.user_metadata?.name || 'Arquiteto(a)',
      avatar_url: state.user.user_metadata?.avatar_url || state.user.user_metadata?.picture,
      is_admin: Boolean(state.profile?.is_admin),
      cau_number: previousCau || null,
    };
  }
  await refreshCauValidity();
}

async function refreshCauValidity() {
  if (!state.user || !state.supabase) return;
  try {
    const { data, error } = await state.supabase.rpc('current_user_has_valid_cau');
    if (error) return;
    if (!data && state.profile) {
      state.profile = { ...state.profile, cau_number: null };
    }
  } catch {
    /* função ainda não existe no banco — usa o perfil local */
  }
}

async function signInWithGoogle() {
  const { error } = await state.supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: authRedirectTo() },
  });
  if (error) {
    announce('Não foi possível iniciar o login.');
    showConfigBanner(`Falha no login: ${escapeHtml(error.message)}`);
  }
}

async function signOut() {
  await state.supabase.auth.signOut();
}

async function recordConsent() {
  await state.supabase.rpc('record_consent');
}

async function loadPosts() {
  if (!state.supabase) return;
  const posts = await fetchFeedPosts();
  if (!posts) return;
  state.postsBase = posts;
  applyLocalSearch();
  if (state.searchTerm) await searchRemote();
  syncTopicButtons();
  await revealSharedPost();
}

async function fetchFeedPosts(searchTerm = '') {
  let query = state.supabase.from('posts_feed').select('*');
  if (state.filterType !== 'todos') query = query.eq('type', state.filterType);
  const safe = sanitizeIlike(searchTerm);
  if (safe) {
    query = query.or(`title.ilike.%${safe}%,content.ilike.%${safe}%`);
  }
  query =
    state.sort === 'apoios'
      ? query.order('likes_count', { ascending: false }).order('created_at', { ascending: false })
      : query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) {
    if (!searchTerm) {
      showConfigBanner(`Não foi possível carregar o feed: ${escapeHtml(error.message)}`);
      els.feedEmpty?.classList.remove('hidden');
    }
    return null;
  }
  let posts = data || [];
  if (state.topicFilter) {
    const topic = state.topicFilter;
    const { data: comments } = await state.supabase.from('comments_feed').select('post_id, content');
    const postIds = new Set(
      (comments || []).filter((row) => hasHashtag(row.content, topic)).map((row) => row.post_id),
    );
    posts = posts.filter((post) => hasHashtag(post.content, topic) || postIds.has(post.id));
  }
  return posts;
}

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function sanitizeIlike(term) {
  return String(term || '')
    .replace(/[,()\\*%]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function postMatchesSearch(post, foldedQuery) {
  if (!foldedQuery) return true;
  const tags = String(post.content || '').match(/#[A-Za-z0-9_À-ÿ]+/g) || [];
  return foldText([post.title, post.content, ...tags].join(' ')).includes(foldedQuery);
}

function filterPostsLocal(posts, term) {
  const folded = foldText(term);
  if (!folded) return [...posts];
  return posts.filter((post) => postMatchesSearch(post, folded));
}

function sortFeedPosts(posts) {
  const list = [...posts];
  if (state.sort === 'apoios') {
    list.sort(
      (a, b) =>
        (Number(b.likes_count) || 0) - (Number(a.likes_count) || 0) ||
        new Date(b.created_at) - new Date(a.created_at),
    );
  } else {
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  return list;
}

function mergeSearchResults(remote, local) {
  const byId = new Map();
  for (const post of [...(remote || []), ...local]) {
    if (post?.id) byId.set(post.id, post);
  }
  return sortFeedPosts([...byId.values()]);
}

function applyLocalSearch() {
  state.posts = filterPostsLocal(state.postsBase, state.searchTerm);
  renderFeed();
  updateSearchStatus();
}

async function searchRemote() {
  const term = state.searchTerm;
  const token = ++searchSeq;
  if (!term) {
    state.posts = [...state.postsBase];
    renderFeed();
    updateSearchStatus();
    return;
  }
  const remote = sanitizeIlike(term) ? await fetchFeedPosts(term) : [];
  if (token !== searchSeq || remote == null) return;
  const localHits = filterPostsLocal(state.postsBase, term);
  state.posts = mergeSearchResults(remote, localHits);
  renderFeed();
  updateSearchStatus();
}

function scheduleRemoteSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchRemote();
  }, 300);
}

function syncSearchClear() {
  const hasValue = Boolean(String(els.feedSearch?.value || '').trim());
  els.searchClear?.classList.toggle('hidden', !hasValue);
}

function onSearchInput() {
  state.searchTerm = String(els.feedSearch?.value || '').trim();
  syncSearchClear();
  applyLocalSearch();
  scheduleRemoteSearch();
}

function onSearchSubmit(event) {
  event.preventDefault();
  state.searchTerm = String(els.feedSearch?.value || '').trim();
  syncSearchClear();
  clearTimeout(searchDebounce);
  applyLocalSearch();
  searchRemote();
}

function clearSearch() {
  if (els.feedSearch) els.feedSearch.value = '';
  state.searchTerm = '';
  syncSearchClear();
  clearTimeout(searchDebounce);
  searchSeq += 1;
  state.posts = [...state.postsBase];
  renderFeed();
  updateSearchStatus();
  els.feedSearch?.focus();
}

function updateSearchStatus() {
  if (!els.searchStatus) return;
  const term = state.searchTerm;
  if (!term) {
    els.searchStatus.textContent = '';
    return;
  }
  if (state.posts.length) {
    els.searchStatus.textContent = `Exibindo resultados para: '${term}'`;
    return;
  }
  els.searchStatus.textContent = 'Nenhum debate encontrado para o termo pesquisado';
}

function focusComposeToCreate() {
  if (!state.user) {
    openLogin();
    return;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (needsCauRegistration()) {
    openCauModal();
    return;
  }
  window.setTimeout(() => {
    document.getElementById('post-content')?.focus();
  }, 280);
}

function refreshComposeFab() {
  const canCompose = Boolean(els.composeBar) && !els.composeBar.classList.contains('hidden');
  if (!canCompose) {
    els.fabNewPost?.classList.remove('is-visible');
    return;
  }
  setupComposeObserver();
}

function setupComposeObserver() {
  if (composeObserver) {
    composeObserver.disconnect();
    composeObserver = null;
  }
  const box = els.ideaBox;
  if (!box) return;
  composeObserver = new IntersectionObserver(
    (entries) => {
      const canCompose = Boolean(els.composeBar) && !els.composeBar.classList.contains('hidden');
      const entry = entries[0];
      const inView = Boolean(entry?.isIntersecting);
      els.fabNewPost?.classList.toggle('is-visible', canCompose && !inView);
    },
    { root: null, threshold: 0, rootMargin: '-8px 0px 0px 0px' },
  );
  composeObserver.observe(box);
}

function setHeaderSearchOpen(open) {
  els.headerSearch?.classList.toggle('is-open', open);
  els.searchToggle?.setAttribute('aria-expanded', String(open));
  if (open) els.feedSearch?.focus();
}

function toggleHeaderSearch() {
  const open = !els.headerSearch?.classList.contains('is-open');
  setHeaderSearchOpen(open);
}

function hasHashtag(text, topic) {
  const safe = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`#${safe}(?![A-Za-z0-9_À-ÿ])`, 'i').test(String(text || ''));
}

function syncTopicButtons() {
  if (!els.trendingList) return;
  els.trendingList.querySelectorAll('[data-topic]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-topic') === state.topicFilter);
  });
  if (els.clearTopic) {
    els.clearTopic.classList.toggle('hidden', !state.topicFilter);
  }
}

async function loadTrendingTopics() {
  const container = els.trendingList;
  if (!container || !state.supabase) return;

  const { data, error } = await state.supabase.rpc('get_trending_topics');
  if (error || !data || data.length === 0) {
    container.innerHTML = `<span class="meta">Nenhum tópico em alta no momento. Use hashtags como #ATHIS nas mensagens.</span>`;
    return;
  }

  container.innerHTML = data
    .map(
      (item) => `
      <button type="button" class="topic-chip" data-topic="${escapeHtml(item.topic)}">
        <span>#${escapeHtml(item.topic)}</span>
        <span class="topic-count">${item.total}</span>
      </button>
    `,
    )
    .join('');
  syncTopicButtons();
}

function filterByTopic(topic) {
  state.topicFilter = state.topicFilter === topic ? null : topic;
  loadPosts();
}

async function loadComments(postId) {
  const { data, error } = await state.supabase
    .from('comments_feed')
    .select('*')
    .eq('post_id', postId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  state.commentsByPost.set(postId, data || []);
  return data || [];
}

async function loadReports() {
  if (!isAdmin()) {
    els.adminPanel.classList.add('hidden');
    return;
  }
  els.adminPanel.classList.remove('hidden');
  const { data, error } = await state.supabase
    .from('reports_admin')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    els.reportsList.innerHTML = `<p class="feedback-error">${escapeHtml(error.message)}</p>`;
    return;
  }
  const reports = data || [];
  if (!reports.length) {
    els.reportsList.innerHTML = `<p class="text-sm">Nenhuma denúncia no momento.</p>`;
    return;
  }
  els.reportsList.innerHTML = reports
    .map(
      (report) => `
      <article class="liquid-card comment-item text-sm">
        <p><strong>Motivo:</strong> ${escapeHtml(report.reason)}</p>
        <p class="meta">${report.post_id ? 'Publicação' : 'Comentário'} · ${formatDate(report.created_at)} · ${escapeHtml(report.status)}</p>
        ${
          report.status === 'aberta'
            ? `<button type="button" class="btn-text mt-2" data-review-report="${report.id}">Marcar como revisada</button>`
            : ''
        }
      </article>
    `,
    )
    .join('');
}

function shareTitleFromPost(post) {
  const fromTitle = String(post?.title || '').trim();
  if (fromTitle) return fromTitle.slice(0, 120);
  const fromContent = String(post?.content || '').trim();
  if (fromContent) return fromContent.slice(0, 80);
  return 'Proposta no Múltiplas';
}

function postShareUrl(postId) {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('post', postId);
  return url.toString();
}

function canUseNativeShare() {
  if (typeof navigator.share !== 'function') return false;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return coarse || mobileUa;
}

function socialShareUrls(postId, postTitle) {
  const title = String(postTitle || 'Proposta no Múltiplas').trim() || 'Proposta no Múltiplas';
  const postUrl = postShareUrl(postId);
  return {
    postUrl,
    whatsapp: `https://api.whatsapp.com/send?text=${encodeURIComponent(
      `Confira esta proposta para o CAU/SC no Múltiplas: "${title}" ${postUrl}`,
    )}`,
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      `Proposta no Múltiplas: ${title}`,
    )}&url=${encodeURIComponent(postUrl)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(postUrl)}`,
  };
}

function showShareToast(message) {
  const toast = els.shareToast;
  if (toast) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(shareToastTimer);
    shareToastTimer = window.setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 2600);
  }
  announce(message);
}

async function copyPostLink(postUrl) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard');
    await navigator.clipboard.writeText(postUrl);
    showShareToast('Link copiado para a área de transferência!');
  } catch {
    const input = document.createElement('textarea');
    input.value = postUrl;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    if (ok) {
      showShareToast('Link copiado para a área de transferência!');
    } else {
      announce('Não foi possível copiar o link.');
    }
  }
}

function closeShareMenu(card) {
  const btn = card?.querySelector('[data-share]');
  const wrap = card?.querySelector('[data-share-wrap]');
  const menuId = btn?.getAttribute('aria-controls');
  const menu = (menuId && document.getElementById(menuId)) || card?.querySelector('[data-share-menu]');
  card?.classList.remove('is-share-open');
  if (card) card.style.zIndex = '';
  if (menu) {
    menu.classList.add('hidden');
    menu.style.position = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.zIndex = '';
    if (wrap && menu.parentElement !== wrap) wrap.appendChild(menu);
  }
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function closeAllShareMenus(exceptCard = null) {
  els.feed?.querySelectorAll('[data-post-card]').forEach((card) => {
    if (exceptCard && card === exceptCard) return;
    closeShareMenu(card);
  });
}

function positionShareMenu(btn, menu) {
  const rect = btn.getBoundingClientRect();
  const width = menu.offsetWidth || 216;
  let left = rect.left;
  if (left + width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - width - 8);
  }
  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${rect.bottom + 8}px`;
  menu.style.bottom = 'auto';
  menu.style.zIndex = '80';
}

function openShareMenu(card) {
  closeAllShareMenus(card);
  card.classList.add('is-share-open');
  const menu = card.querySelector('[data-share-menu]');
  const btn = card.querySelector('[data-share]');
  if (!menu || !btn) return;
  document.body.appendChild(menu);
  menu.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  positionShareMenu(btn, menu);
}

function openShareUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function sharePost(postId, postTitle, channel) {
  const urls = socialShareUrls(postId, postTitle);
  if (!channel && canUseNativeShare()) {
    try {
      await navigator.share({
        title: 'Múltiplas — CAU/SC',
        text: `Confira esta proposta para o CAU/SC no Múltiplas: "${postTitle}"`,
        url: urls.postUrl,
      });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        const card = els.feed?.querySelector(`[data-post-card][data-post-id="${CSS.escape(String(postId))}"]`);
        if (card) openShareMenu(card);
      }
    }
    return urls;
  }

  if (channel === 'whatsapp') {
    openShareUrl(urls.whatsapp);
  } else if (channel === 'twitter' || channel === 'x') {
    openShareUrl(urls.twitter);
  } else if (channel === 'linkedin') {
    openShareUrl(urls.linkedin);
  } else if (channel === 'copy') {
    await copyPostLink(urls.postUrl);
  }

  return urls;
}

function onShareButtonClick(event, post, card) {
  event.preventDefault();
  event.stopPropagation();
  const btn = event.currentTarget;
  const wasOpen = btn.getAttribute('aria-expanded') === 'true';
  closeAllShareMenus();
  if (wasOpen) return;
  if (canUseNativeShare()) {
    sharePost(post.id, shareTitleFromPost(post));
    return;
  }
  openShareMenu(card);
}

function sharedPostIdFromUrl() {
  const id = new URLSearchParams(window.location.search).get('post');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return id;
}

function highlightSharedPost(postId, animate = true) {
  const card = els.feed?.querySelector(`[data-post-card][data-post-id="${CSS.escape(postId)}"]`);
  if (!card) return false;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate) {
    card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    card.setAttribute('tabindex', '-1');
    card.focus({ preventScroll: true });
  }
  card.classList.add('is-shared-highlight');
  window.clearTimeout(sharedGlowTimer);
  sharedGlowTimer = window.setTimeout(() => {
    card.classList.remove('is-shared-highlight');
  }, 3600);
  return true;
}

async function revealSharedPost() {
  const postId = sharedPostIdFromUrl();
  if (!postId) return;

  let post = state.posts.find((item) => item.id === postId) || state.postsBase.find((item) => item.id === postId);
  if (!post && state.supabase) {
    const { data, error } = await state.supabase.from('posts_feed').select('*').eq('id', postId).maybeSingle();
    if (error || !data) {
      if (!sharedHighlightDone) announce('Não foi possível abrir a proposta compartilhada.');
      sharedHighlightDone = true;
      return;
    }
    post = data;
  }

  if (!post) return;

  if (!state.posts.some((item) => item.id === postId)) {
    state.posts = [post, ...state.posts.filter((item) => item.id !== postId)];
    renderFeed();
  }

  const shouldAnimate = !sharedHighlightDone;
  sharedHighlightDone = true;
  requestAnimationFrame(() => {
    highlightSharedPost(postId, shouldAnimate);
  });
}

function renderFeed() {
  els.feed.innerHTML = '';
  const searching = Boolean(state.searchTerm);
  if (!state.posts.length) {
    els.feedEmpty.classList.toggle('hidden', searching);
    els.feedSearchEmpty?.classList.toggle('hidden', !searching);
    return;
  }
  els.feedEmpty.classList.add('hidden');
  els.feedSearchEmpty?.classList.add('hidden');
  const fragment = document.createDocumentFragment();
  for (const post of state.posts) {
    fragment.appendChild(renderCard(post));
  }
  els.feed.appendChild(fragment);
}

function renderCard(post) {
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  const badge = node.querySelector('[data-badge]');
  const isIdeia = post.type === 'ideia';
  badge.textContent = isIdeia ? 'IDEIA' : 'RECLAMAÇÃO';
  badge.classList.add(isIdeia ? 'badge-ideia' : 'badge-reclamacao');
  node.classList.add(isIdeia ? 'category-ideia' : 'category-reclamacao');
  node.querySelector('[data-author]').textContent = post.author_name;
  const time = node.querySelector('[data-date]');
  time.dateTime = post.created_at;
  time.textContent = formatDate(post.created_at);
  node.querySelector('[data-content]').textContent = post.content;
  node.querySelector('[data-like-count]').textContent = post.likes_count ?? 0;
  node.querySelector('[data-comment-count]').textContent = post.comments_count ?? 0;
  node.dataset.postId = post.id;

  const likeBtn = node.querySelector('[data-like]');
  likeBtn.setAttribute('aria-pressed', post.liked_by_me ? 'true' : 'false');
  if (!state.user) {
    likeBtn.title = 'Entre para apoiar';
  }

  const deleteOwn = node.querySelector('[data-delete-own]');
  if (post.is_own) deleteOwn.classList.remove('hidden');

  const adminActions = node.querySelector('[data-admin-actions]');
  if (isAdmin()) {
    adminActions.innerHTML = `<button type="button" data-admin-delete class="btn-danger">Deletar post</button>`;
  }

  const commentForm = node.querySelector('[data-comment-form]');
  const commentInput = node.querySelector('[data-comment-input]');
  const commentLabel = node.querySelector('[data-comment-label]');
  commentInput.id = `comment-${post.id}`;
  commentLabel.setAttribute('for', commentInput.id);
  if (state.user) commentForm.classList.remove('hidden');

  node.id = `post-${post.id}`;
  const shareBtn = node.querySelector('[data-share]');
  const shareMenu = node.querySelector('[data-share-menu]');
  if (shareBtn && shareMenu) {
    const menuId = `share-menu-${post.id}`;
    shareMenu.id = menuId;
    shareBtn.setAttribute('aria-controls', menuId);
    shareBtn.addEventListener('click', (event) => onShareButtonClick(event, post, node));
    shareMenu.querySelectorAll('[data-share-to]').forEach((option) => {
      option.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        sharePost(post.id, shareTitleFromPost(post), option.getAttribute('data-share-to'));
        closeShareMenu(node);
      });
    });
  }

  likeBtn.addEventListener('click', () => toggleLike(post, node));
  node.querySelector('[data-toggle-comments]').addEventListener('click', (event) => toggleComments(post.id, node, event.currentTarget));
  node.querySelector('[data-report]').addEventListener('click', () => openReport({ postId: post.id }));
  deleteOwn.addEventListener('click', () => deletePost(post.id, false));
  adminActions.querySelector('[data-admin-delete]')?.addEventListener('click', () => deletePost(post.id, true));
  commentForm.addEventListener('submit', (event) => submitComment(event, post.id, node));
  const followBtn = node.querySelector('[data-follow]');
  if (followBtn) {
    syncFollowButton(followBtn, post.id);
    followBtn.addEventListener('click', () => openFollowDialog(post));
  }
  return node;
}

async function toggleLike(post, card) {
  if (!state.user) {
    openLogin();
    return;
  }
  const nextLiked = !post.liked_by_me;
  const nextCount = Math.max(0, (post.likes_count || 0) + (nextLiked ? 1 : -1));
  post.liked_by_me = nextLiked;
  post.likes_count = nextCount;
  card.querySelector('[data-like-count]').textContent = nextCount;
  card.querySelector('[data-like]').setAttribute('aria-pressed', String(nextLiked));
  try {
    const { data, error } = await state.supabase.rpc('toggle_like', { p_post_id: post.id });
    if (error) throw error;
    const payload = Array.isArray(data) ? data[0] : data;
    if (payload) {
      post.liked_by_me = payload.liked;
      post.likes_count = payload.likes_count;
      card.querySelector('[data-like-count]').textContent = payload.likes_count;
      card.querySelector('[data-like]').setAttribute('aria-pressed', String(payload.liked));
    }
    announce(post.liked_by_me ? 'Apoio registrado.' : 'Apoio removido.');
  } catch (error) {
    post.liked_by_me = !nextLiked;
    post.likes_count = Math.max(0, nextCount + (nextLiked ? -1 : 1));
    card.querySelector('[data-like-count]').textContent = post.likes_count;
    announce(error.message || 'Não foi possível registrar o apoio.');
  }
}

async function toggleComments(postId, card, button) {
  const panel = card.querySelector('[data-comments-panel]');
  const expanded = button.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    panel.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  panel.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  await renderComments(postId, card);
}

async function renderComments(postId, card) {
  const list = card.querySelector('[data-comments-list]');
  list.innerHTML = `<p class="text-sm">Carregando comentários…</p>`;
  try {
    const comments = await loadComments(postId);
    if (!comments.length) {
      list.innerHTML = `<p class="text-sm text-ink/70">Nenhum comentário ainda.</p>`;
      return;
    }
    const tree = nestComments(comments);
    list.innerHTML = `<div class="comment-thread">${tree.map((comment) => renderCommentNode(comment, true)).join('')}</div>`;
    bindCommentListEvents(list, postId, card);
  } catch (error) {
    list.innerHTML = `<p class="feedback-error">${escapeHtml(error.message)}</p>`;
  }
}

function nestComments(comments) {
  const nodes = new Map((comments || []).map((item) => [item.id, { ...item, replies: [] }]));
  const roots = [];
  for (const item of comments || []) {
    const node = nodes.get(item.id);
    if (item.parent_id && nodes.has(item.parent_id)) {
      const parent = nodes.get(item.parent_id);
      if (parent.parent_id && nodes.has(parent.parent_id)) {
        nodes.get(parent.parent_id).replies.push(node);
      } else {
        parent.replies.push(node);
      }
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function commentActionButtons(comment, allowReply) {
  const ownBtn = comment.is_own
    ? `<button type="button" class="btn-text" data-del-comment="${comment.id}">Excluir</button>`
    : '';
  const hideBtn = isAdmin()
    ? `<button type="button" class="btn-text" data-hide-comment="${comment.id}" data-hidden="${comment.is_hidden}">${comment.is_hidden ? 'Reexibir' : 'Ocultar'}</button>`
    : '';
  const reportBtn = state.user
    ? `<button type="button" class="btn-text" data-report-comment="${comment.id}">Denunciar</button>`
    : '';
  const replyBtn = allowReply
    ? `<button type="button" class="btn-text" data-reply="${comment.id}">Responder</button>`
    : '';
  return `${replyBtn}${ownBtn}${hideBtn}${reportBtn}`;
}

function renderCommentNode(comment, allowReply) {
  const hiddenNote = comment.is_hidden ? ' <span class="admin-tag">Oculto</span>' : '';
  const replies = (comment.replies || [])
    .map((reply) => renderCommentNode(reply, false))
    .join('');
  const replyForm = allowReply
    ? `<form class="reply-form hidden" data-reply-form data-parent-id="${comment.id}">
        <label class="sr-only">Responder</label>
        <textarea class="glass-textarea" data-reply-input minlength="3" maxlength="800" rows="2" required placeholder="Escreva uma resposta…"></textarea>
        <label class="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" data-reply-anon />
          Responder como anônimo
        </label>
        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn btn-primary">Responder</button>
          <button type="button" class="btn-text" data-reply-cancel>Cancelar</button>
        </div>
        <p class="meta" data-reply-feedback></p>
      </form>`
    : '';
  return `
    <article class="liquid-card comment-item ${allowReply ? '' : 'comment-reply'} ${comment.is_hidden ? 'opacity-70' : ''}" data-comment-id="${comment.id}">
      <p class="meta"><strong>${escapeHtml(comment.author_name)}</strong> · <time datetime="${comment.created_at}">${formatDate(comment.created_at)}</time>${hiddenNote}</p>
      <p class="mt-1 whitespace-pre-wrap text-sm">${escapeHtml(comment.content)}</p>
      <div class="comment-actions">${commentActionButtons(comment, allowReply)}</div>
      ${replyForm}
      ${replies ? `<div class="comment-replies">${replies}</div>` : ''}
    </article>
  `;
}

function bindCommentListEvents(list, postId, card) {
  list.querySelectorAll('[data-del-comment]').forEach((btn) => {
    btn.addEventListener('click', () => deleteComment(btn.getAttribute('data-del-comment'), postId, card));
  });
  list.querySelectorAll('[data-hide-comment]').forEach((btn) => {
    btn.addEventListener('click', () =>
      hideComment(btn.getAttribute('data-hide-comment'), btn.getAttribute('data-hidden') === 'true', postId, card),
    );
  });
  list.querySelectorAll('[data-report-comment]').forEach((btn) => {
    btn.addEventListener('click', () => openReport({ commentId: btn.getAttribute('data-report-comment') }));
  });
  list.querySelectorAll('[data-reply]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.user) {
        openLogin();
        return;
      }
      const article = btn.closest('[data-comment-id]');
      const form = article?.querySelector('[data-reply-form]');
      if (!form) return;
      const open = !form.classList.contains('hidden');
      list.querySelectorAll('[data-reply-form]').forEach((other) => other.classList.add('hidden'));
      if (open) return;
      form.classList.remove('hidden');
      form.querySelector('[data-reply-input]')?.focus();
    });
  });
  list.querySelectorAll('[data-reply-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('[data-reply-form]')?.classList.add('hidden'));
  });
  list.querySelectorAll('[data-reply-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      submitComment(event, postId, card, form.getAttribute('data-parent-id'));
    });
  });
}

async function submitPost(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!assertNotBot(form)) return;
  if (!hasCauNumber() || !hasLgpdConsent()) {
    showFeedback(els.postFeedback, 'Informe o registro do CAU e aceite os termos da LGPD para publicar.', true);
    openCauModal();
    return;
  }
  const content = document.getElementById('post-content').value.trim();
  const limitesPost = { min: MIN_CHARS, max: MAX_CHARS_POST };
  if (motivoRetencao(content, limitesPost)) {
    reterConteudo(els.postFeedback, content, limitesPost);
    return;
  }
  try {
    assertRateLimit();
  } catch (error) {
    showFeedback(els.postFeedback, error.message, true);
    return;
  }
  const type = document.getElementById('post-type').value;
  const isAnonymous = document.getElementById('post-anonymous').checked;
  const title = content.slice(0, 80);
  showFeedback(els.postFeedback, 'Publicando…');
  await recordConsent();
  const { error } = await state.supabase.from('posts').insert({
    type,
    title,
    content,
    is_anonymous: isAnonymous,
    lgpd_consent: true,
  });
  if (error) {
    showFeedback(els.postFeedback, mensagemErroPublicar(error.message), true);
    if (/row-level security|rls/i.test(error.message) || needsCauRegistration()) {
      openCauModal();
    }
    return;
  }
  markSubmitted();
  hideModerationAlert();
  form.reset();
  document.getElementById('post-type').value = type;
  showFeedback(els.postFeedback, 'Publicação enviada.');
  announce('Publicação enviada.');
  await loadPosts();
  await loadTrendingTopics();
}

async function submitComment(event, postId, card, parentId = null) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!assertNotBot(form)) return;
  const feedback =
    form.querySelector('[data-reply-feedback]') || card.querySelector('[data-comment-feedback]');
  const content = (form.querySelector('[data-reply-input], [data-comment-input]')?.value || '').trim();
  const limitesComentario = { min: MIN_CHARS, max: MAX_CHARS_COMENTARIO };
  if (motivoRetencao(content, limitesComentario)) {
    reterConteudo(feedback, content, limitesComentario);
    return;
  }
  try {
    assertRateLimit();
  } catch (error) {
    showFeedback(feedback, error.message, true);
    return;
  }
  await recordConsent();
  const payload = {
    post_id: postId,
    content,
    is_anonymous: form.querySelector('[data-comment-anon], [data-reply-anon]')?.checked || false,
    lgpd_consent: true,
  };
  if (parentId) payload.parent_id = parentId;
  const { error } = await state.supabase.from('comments').insert(payload);
  if (error) {
    showFeedback(feedback, error.message, true);
    return;
  }
  markSubmitted();
  hideModerationAlert();
  form.reset();
  showFeedback(feedback, parentId ? 'Resposta publicada.' : 'Comentário publicado.');
  await renderComments(postId, card);
  await loadPosts();
  await loadTrendingTopics();
  await loadNotifications();
}

function subscriptionFor(postId) {
  return state.subscriptions.get(postId) || null;
}

function syncFollowButton(button, postId) {
  if (!button) return;
  const sub = subscriptionFor(postId);
  const following = Boolean(sub);
  button.setAttribute('aria-pressed', String(following));
  const label = button.querySelector('[data-follow-label]');
  if (label) label.textContent = following ? 'Seguindo' : 'Seguir Debate';
}

function syncFollowButtons() {
  document.querySelectorAll('[data-follow]').forEach((btn) => {
    const card = btn.closest('[data-post-card]');
    if (card?.dataset.postId) syncFollowButton(btn, card.dataset.postId);
  });
}

function openFollowDialog(post) {
  if (!state.user) {
    openLogin();
    return;
  }
  followTarget = post;
  const sub = subscriptionFor(post.id);
  const title = document.getElementById('follow-title');
  const message = document.getElementById('follow-message');
  const emailBtn = document.getElementById('follow-email');
  const siteBtn = document.getElementById('follow-site');
  if (sub) {
    if (title) title.textContent = 'Você já segue este debate';
    if (message) {
      message.textContent = sub.notify_email
        ? 'Avisos no site estão ativos e o e-mail deste debate está ligado. Você pode desativar só o e-mail ou deixar de seguir.'
        : 'Avisos no site estão ativos. Você pode passar a receber e-mail ou deixar de seguir.';
    }
    if (emailBtn) emailBtn.textContent = sub.notify_email ? 'Desativar e-mails deste debate' : 'Sim, enviar e-mails';
    if (siteBtn) siteBtn.textContent = 'Deixar de seguir';
  } else {
    if (title) title.textContent = 'Seguir debate';
    if (message) {
      message.textContent =
        'Deseja receber notificações por e-mail quando houver novas respostas neste debate?';
    }
    if (emailBtn) emailBtn.textContent = 'Sim, enviar e-mails';
    if (siteBtn) siteBtn.textContent = 'Apenas no site';
  }
  els.followDialog?.showModal();
}

async function confirmFollowChoice(wantEmail) {
  const post = followTarget;
  if (!post) return;
  const sub = subscriptionFor(post.id);
  try {
    if (sub && wantEmail && sub.notify_email) {
      await state.supabase.rpc('set_subscription_email', { p_post_id: post.id, p_notify_email: false });
      announce('E-mails deste debate desativados.');
    } else if (sub && !wantEmail) {
      await state.supabase.rpc('unsubscribe_from_post', { p_post_id: post.id });
      announce('Você deixou de seguir o debate.');
    } else {
      const { error } = await state.supabase.rpc('subscribe_to_post', {
        p_post_id: post.id,
        p_notify_email: Boolean(wantEmail),
      });
      if (error) throw error;
      announce(wantEmail ? 'Você segue o debate e aceitou e-mails.' : 'Você segue o debate só no site.');
    }
    await loadSubscriptions();
    syncFollowButtons();
  } catch (error) {
    announce(error.message || 'Não foi possível atualizar o acompanhamento.');
  } finally {
    els.followDialog?.close();
    followTarget = null;
  }
}

async function loadSubscriptions() {
  if (!state.user || !state.supabase) {
    state.subscriptions = new Map();
    return;
  }
  const { data, error } = await state.supabase.rpc('list_my_subscriptions');
  if (error) {
    state.subscriptions = new Map();
    return;
  }
  state.subscriptions = new Map((data || []).map((row) => [row.post_id, row]));
}

function inAppNotificationsEnabled() {
  if (!state.profile) return true;
  if (!Object.prototype.hasOwnProperty.call(state.profile, 'notify_in_app')) return true;
  return Boolean(state.profile.notify_in_app);
}

function syncNotifyBell() {
  const show = Boolean(state.user) && inAppNotificationsEnabled();
  els.notifyWrap?.classList.toggle('hidden', !show);
  if (!show) {
    els.notifyMenu?.classList.add('hidden');
    els.notifyBell?.setAttribute('aria-expanded', 'false');
  }
  const unread = (state.notifications || []).filter((item) => !item.read_at).length;
  if (els.notifyBadge) {
    els.notifyBadge.textContent = unread > 99 ? '99+' : String(unread);
    els.notifyBadge.classList.toggle('hidden', unread === 0 || !show);
  }
}

function renderNotifyMenu() {
  const menu = els.notifyMenu;
  if (!menu) return;
  const items = state.notifications || [];
  if (!items.length) {
    menu.innerHTML = `<p class="notify-empty">Nenhuma notificação por enquanto.</p>`;
    return;
  }
  menu.innerHTML = items
    .map(
      (item) => `
      <button type="button" class="notify-item ${item.read_at ? '' : 'is-unread'}" data-notify-id="${item.id}" data-post-id="${item.post_id || ''}" role="menuitem">
        ${escapeHtml(item.message)}
        <span class="meta" style="display:block;margin-top:0.25rem">${formatDate(item.created_at)}</span>
      </button>
    `,
    )
    .join('');
}

function closeNotifyMenu() {
  els.notifyMenu?.classList.add('hidden');
  els.notifyBell?.setAttribute('aria-expanded', 'false');
}

function toggleNotifyMenu() {
  if (!state.user) {
    openLogin();
    return;
  }
  const open = !els.notifyMenu?.classList.contains('hidden');
  if (open) {
    closeNotifyMenu();
    return;
  }
  renderNotifyMenu();
  els.notifyMenu?.classList.remove('hidden');
  els.notifyBell?.setAttribute('aria-expanded', 'true');
  loadNotifications();
}

async function loadNotifications() {
  if (!state.user || !state.supabase) {
    state.notifications = [];
    syncNotifyBell();
    return;
  }
  const { data, error } = await state.supabase
    .from('notifications_mine')
    .select('id, type, post_id, comment_id, message, read_at, created_at')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) {
    state.notifications = [];
    syncNotifyBell();
    return;
  }
  state.notifications = data || [];
  syncNotifyBell();
  if (els.notifyMenu && !els.notifyMenu.classList.contains('hidden')) renderNotifyMenu();
}

async function openNotification(item) {
  if (!item?.id) return;
  await state.supabase.rpc('mark_notification_read', { p_id: item.id }).catch(() => {});
  item.read_at = new Date().toISOString();
  closeNotifyMenu();
  await loadNotifications();
  if (item.post_id) await focusPost(item.post_id, true);
}

async function focusPost(postId, openComments) {
  sharedHighlightDone = false;
  const params = new URLSearchParams(window.location.search);
  params.set('post', postId);
  const next = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, '', next);
  await revealSharedPost();
  if (!openComments) return;
  const card = els.feed?.querySelector(`[data-post-card][data-post-id="${CSS.escape(postId)}"]`);
  const toggle = card?.querySelector('[data-toggle-comments]');
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
    await toggleComments(postId, card, toggle);
  }
}

function startNotifyPoll() {
  stopNotifyPoll();
  if (!state.user) return;
  notifyPoll = window.setInterval(() => {
    loadNotifications();
  }, 45000);
}

function stopNotifyPoll() {
  if (notifyPoll) {
    clearInterval(notifyPoll);
    notifyPoll = null;
  }
}

async function openAccountSettings() {
  if (!state.user) {
    openLogin();
    return;
  }
  const email = document.getElementById('pref-allow-email');
  const inApp = document.getElementById('pref-in-app');
  if (email) email.checked = state.profile?.allow_email_notifications !== false;
  if (inApp) inApp.checked = state.profile?.notify_in_app !== false;
  await loadSubscriptions();
  renderFollowedList();
  els.accountDialog?.showModal();
}

function renderFollowedList() {
  const box = document.getElementById('followed-list');
  if (!box) return;
  const rows = [...state.subscriptions.values()];
  if (!rows.length) {
    box.innerHTML = `<p class="meta">Você ainda não segue nenhum debate.</p>`;
    return;
  }
  box.innerHTML = rows
    .map(
      (row) => `
      <article class="followed-item">
        <p class="text-sm" style="margin:0">${escapeHtml(row.post_title || 'Proposta')}</p>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn-text" data-sub-email="${row.post_id}" data-on="${row.notify_email ? '1' : '0'}">
            ${row.notify_email ? 'Desativar e-mails deste debate' : 'Ativar e-mails deste debate'}
          </button>
          <button type="button" class="btn-text" data-sub-unfollow="${row.post_id}">Deixar de seguir</button>
        </div>
      </article>
    `,
    )
    .join('');
}

async function saveNotificationPrefs() {
  const allowEmail = document.getElementById('pref-allow-email')?.checked !== false;
  const notifyInApp = document.getElementById('pref-in-app')?.checked !== false;
  const { error } = await state.supabase.rpc('set_notification_prefs', {
    p_allow_email: allowEmail,
    p_notify_in_app: notifyInApp,
  });
  if (error) {
    announce(error.message || 'Não foi possível salvar as preferências.');
    return;
  }
  state.profile = {
    ...(state.profile || {}),
    allow_email_notifications: allowEmail,
    notify_in_app: notifyInApp,
  };
  syncNotifyBell();
  announce('Preferências atualizadas.');
}

async function handleFollowedListClick(event) {
  const unfollow = event.target.closest('[data-sub-unfollow]');
  const emailBtn = event.target.closest('[data-sub-email]');
  try {
    if (unfollow) {
      const { error } = await state.supabase.rpc('unsubscribe_from_post', {
        p_post_id: unfollow.getAttribute('data-sub-unfollow'),
      });
      if (error) throw error;
      announce('Você deixou de seguir o debate.');
    } else if (emailBtn) {
      const on = emailBtn.getAttribute('data-on') === '1';
      const { error } = await state.supabase.rpc('set_subscription_email', {
        p_post_id: emailBtn.getAttribute('data-sub-email'),
        p_notify_email: !on,
      });
      if (error) throw error;
      announce(on ? 'E-mails deste debate desativados.' : 'E-mails deste debate ativados.');
    } else {
      return;
    }
    await loadSubscriptions();
    renderFollowedList();
    syncFollowButtons();
  } catch (error) {
    announce(error.message || 'Não foi possível atualizar o debate.');
  }
}

async function deletePost(postId, asAdmin) {
  const ok = await confirmAction(
    asAdmin ? 'Deletar post (moderação)' : 'Excluir publicação',
    asAdmin
      ? 'Esta publicação será removida do debate. A ação é irreversível.'
      : 'Você está exercendo o direito de eliminação (art. 18 da LGPD). Esta ação é irreversível, deseja continuar?',
  );
  if (!ok) return;
  const { error } = await state.supabase.rpc('delete_post', { p_id: postId });
  if (error) {
    announce(error.message);
    return;
  }
  announce('Publicação excluída.');
  await loadPosts();
  await loadTrendingTopics();
}

async function deleteComment(commentId, postId, card) {
  const ok = await confirmAction('Excluir comentário', 'O comentário será eliminado. Continuar?');
  if (!ok) return;
  const { error } = await state.supabase.rpc('delete_comment', { p_id: commentId });
  if (error) {
    announce(error.message);
    return;
  }
  await renderComments(postId, card);
  await loadPosts();
  await loadTrendingTopics();
}

async function hideComment(commentId, currentlyHidden, postId, card) {
  const { error } = await state.supabase.rpc('hide_comment', {
    p_id: commentId,
    p_hidden: !currentlyHidden,
  });
  if (error) {
    announce(error.message);
    return;
  }
  await renderComments(postId, card);
  await loadPosts();
}

async function deleteMyContributions() {
  const ok = await confirmAction(
    'Excluir minhas contribuições',
    'Todas as suas publicações, comentários, apoios e denúncias serão eliminados. O perfil de login permanece até você apagar a conta no provedor.',
  );
  if (!ok) return;
  const { error } = await state.supabase.rpc('delete_my_contributions');
  if (error) {
    announce(error.message);
    return;
  }
  announce('Suas contribuições foram excluídas.');
  await loadPosts();
}

function openReport({ postId = null, commentId = null }) {
  if (!state.user) {
    openLogin();
    return;
  }
  document.getElementById('report-post-id').value = postId || '';
  document.getElementById('report-comment-id').value = commentId || '';
  document.getElementById('report-reason').value = '';
  els.reportDialog.showModal();
}

async function submitReport(event) {
  event.preventDefault();
  const postId = document.getElementById('report-post-id').value || null;
  const commentId = document.getElementById('report-comment-id').value || null;
  const reason = document.getElementById('report-reason').value.trim();
  const { error } = await state.supabase.from('reports').insert({
    post_id: postId,
    comment_id: commentId,
    reason,
  });
  if (error) {
    announce(error.message);
    return;
  }
  els.reportDialog.close();
  announce('Denúncia enviada à moderação.');
}

async function reviewReport(id) {
  const { error } = await state.supabase.rpc('review_report', { p_id: id });
  if (error) {
    announce(error.message);
    return;
  }
  await loadReports();
}

async function onAuthChange(session) {
  const previousId = state.user?.id;
  state.user = session?.user ?? null;
  if (!state.user || state.user.id !== previousId) {
    cauPromptShown = false;
  }
  await loadProfile();
  if (state.user && localStorage.getItem('multipla_lgpd_ok') === '1') {
    await recordConsent().catch(() => {});
  }
  renderAuth();
  maybePromptCau();
  await loadSubscriptions();
  await loadPosts();
  await loadReports();
  await loadTrendingTopics();
  await loadNotifications();
  startNotifyPoll();
}

function bindStaticEvents() {
  document.getElementById('filter-type').addEventListener('change', (event) => {
    state.filterType = event.target.value;
    loadPosts();
  });
  document.getElementById('filter-sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    loadPosts();
  });
  els.postForm.addEventListener('submit', submitPost);
  els.searchForm?.addEventListener('submit', onSearchSubmit);
  els.feedSearch?.addEventListener('input', onSearchInput);
  els.feedSearch?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (els.headerSearch?.classList.contains('is-open')) {
        setHeaderSearchOpen(false);
        return;
      }
      clearSearch();
    }
  });
  els.searchClear?.addEventListener('click', clearSearch);
  els.searchCreate?.addEventListener('click', focusComposeToCreate);
  els.searchToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleHeaderSearch();
  });
  els.fabNewPost?.addEventListener('click', focusComposeToCreate);
  setupComposeObserver();
  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-share-wrap]') && !event.target.closest('[data-share-menu]')) {
      closeAllShareMenus();
    }
    if (!event.target.closest('#notify-wrap')) closeNotifyMenu();
    if (!els.headerSearch?.classList.contains('is-open')) return;
    if (els.headerSearch.contains(event.target)) return;
    setHeaderSearchOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAllShareMenus();
      closeNotifyMenu();
    }
  });
  window.addEventListener('resize', () => closeAllShareMenus());
  els.notifyBell?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleNotifyMenu();
  });
  els.notifyMenu?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-notify-id]');
    if (!btn) return;
    const item = (state.notifications || []).find((row) => row.id === btn.getAttribute('data-notify-id'));
    if (item) openNotification(item);
  });
  document.getElementById('follow-email')?.addEventListener('click', () => confirmFollowChoice(true));
  document.getElementById('follow-site')?.addEventListener('click', () => confirmFollowChoice(false));
  document.getElementById('follow-cancel')?.addEventListener('click', () => {
    els.followDialog?.close();
    followTarget = null;
  });
  document.getElementById('account-close')?.addEventListener('click', () => els.accountDialog?.close());
  document.getElementById('pref-allow-email')?.addEventListener('change', saveNotificationPrefs);
  document.getElementById('pref-in-app')?.addEventListener('change', saveNotificationPrefs);
  document.getElementById('followed-list')?.addEventListener('click', handleFollowedListClick);
  document.getElementById('btn-delete-mine')?.addEventListener('click', deleteMyContributions);
  els.cauForm?.addEventListener('submit', submitCau);
  document.getElementById('cau-cancel')?.addEventListener('click', () => els.cauDialog.close());
  document.getElementById('btn-open-cau')?.addEventListener('click', openCauModal);
  document.getElementById('lgpd-policy-link')?.addEventListener('click', openLgpdPolicyDialog);
  document.getElementById('lgpd-policy-close')?.addEventListener('click', () => els.lgpdPolicyDialog?.close());
  document.getElementById('about-link')?.addEventListener('click', openAboutDialog);
  document.getElementById('about-close')?.addEventListener('click', () => els.aboutDialog?.close());
  document.getElementById('moderation-alert-close')?.addEventListener('click', hideModerationAlert);
  document.getElementById('cau-number')?.addEventListener('input', (event) => {
    const caret = event.target.selectionStart;
    const before = event.target.value;
    event.target.value = formatCauInput(event.target.value);
    if (typeof caret === 'number') {
      const delta = event.target.value.length - before.length;
      const next = Math.max(0, Math.min(event.target.value.length, caret + delta));
      event.target.setSelectionRange(next, next);
    }
  });
  document.getElementById('cau-number')?.addEventListener('blur', (event) => {
    event.target.value = formatCauInput(event.target.value);
  });
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!document.getElementById('login-lgpd').checked) return;
    localStorage.setItem('multipla_lgpd_ok', '1');
    await signInWithGoogle();
  });
  document.getElementById('login-cancel').addEventListener('click', () => els.loginDialog.close());
  document.getElementById('report-form').addEventListener('submit', submitReport);
  document.getElementById('report-cancel').addEventListener('click', () => els.reportDialog.close());
  els.reportsList.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-review-report]');
    if (btn) reviewReport(btn.getAttribute('data-review-report'));
  });
  els.trendingList?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-topic]');
    if (btn) filterByTopic(btn.getAttribute('data-topic'));
  });
  els.clearTopic?.addEventListener('click', () => {
    state.topicFilter = null;
    loadPosts();
  });
}

async function init() {
  if (!CONFIG_READY) {
    showConfigBanner(
      'Preencha <code>js/config.js</code> com a URL e a chave anon do Supabase e rode <code>script.sql</code> no SQL Editor. Sem a chave <code>service_role</code>.',
    );
    renderAuth();
    els.feedEmpty.classList.remove('hidden');
    els.feedEmpty.textContent = 'O feed aparece quando o projeto Supabase estiver ligado a este site.';
    if (els.trendingList) {
      els.trendingList.innerHTML = `<span class="meta">Tópicos em alta aparecem após ligar o Supabase.</span>`;
    }
    document.getElementById('about-link')?.addEventListener('click', openAboutDialog);
    document.getElementById('about-close')?.addEventListener('click', () => els.aboutDialog?.close());
    if (window.location.hash === '#sobre') openAboutDialog();
    return;
  }

  state.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  bindStaticEvents();

  state.supabase.auth.onAuthStateChange((_event, session) => {
    onAuthChange(session);
  });

  const { data } = await state.supabase.auth.getSession();
  await onAuthChange(data.session);
  if (window.location.hash === '#sobre') openAboutDialog();
}

init().catch((error) => {
  showConfigBanner(`Erro ao iniciar a aplicação: ${escapeHtml(error.message)}`);
});
