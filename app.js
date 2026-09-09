import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './js/config.js';
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
  commentsByPost: new Map(),
  filterType: 'todos',
  sort: 'recentes',
  topicFilter: null,
};

const els = {
  authSlot: document.getElementById('auth-slot'),
  composeBar: document.getElementById('compose-bar'),
  postForm: document.getElementById('post-form'),
  postFeedback: document.getElementById('post-feedback'),
  feed: document.getElementById('feed'),
  feedEmpty: document.getElementById('feed-empty'),
  adminPanel: document.getElementById('admin-panel'),
  reportsList: document.getElementById('reports-list'),
  configBanner: document.getElementById('config-banner'),
  liveRegion: document.getElementById('live-region'),
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
  composeLock: document.getElementById('compose-lock'),
  moderationAlert: document.getElementById('moderation-alert'),
};

let cauPromptShown = false;
let cauSaveInFlight = false;

function announce(message) {
  els.liveRegion.textContent = message;
}

function isAdmin() {
  return Boolean(state.profile?.is_admin);
}

function hasCauNumber() {
  return Boolean(String(state.profile?.cau_number || '').trim());
}

function normalizarRegistroCAU(cau) {
  return String(cau || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function digitoVerificadorModulo11Direita(digitos) {
  const nums = String(digitos);
  let soma = 0;
  let peso = 2;
  for (let i = nums.length - 1; i >= 0; i -= 1) {
    soma += Number(nums[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function digitoVerificadorModulo11Esquerda(digitos) {
  const nums = String(digitos);
  let soma = 0;
  let peso = 2;
  for (let i = 0; i < nums.length; i += 1) {
    soma += Number(nums[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto === 10 ? 0 : resto;
}

/**
 * Valida o registro do CAU: letra A, números e dígito verificador (Módulo 11).
 * Aceita as duas convenções usuais (pesos da direita ou da esquerda), porque o SICCAU
 * emite números reais que não batem com um único sentido de peso.
 * @param {string} cau
 * @returns {boolean}
 */
function validarRegistroCAU(cau) {
  const value = normalizarRegistroCAU(cau);
  const match = /^A(\d{5,8})-(\d)$/.exec(value);
  if (!match) return false;
  const corpo = match[1];
  const dv = Number(match[2]);
  return (
    digitoVerificadorModulo11Direita(corpo) === dv ||
    digitoVerificadorModulo11Esquerda(corpo) === dv
  );
}

function mensagemErroRegistroCAU(cau) {
  const value = normalizarRegistroCAU(cau);
  if (!value) {
    return 'Informe o seu registro do CAU, no formato A123456-7.';
  }
  if (!/^A\d{5,8}-\d$/.test(value)) {
    return 'O registro deve começar com a letra A, seguida de números e o dígito após o hífen (ex.: A123456-7).';
  }
  if (!validarRegistroCAU(value)) {
    return 'O dígito verificador (número após o hífen) não confere. Confira o número no SICCAU ou no seu cartão do CAU.';
  }
  return '';
}

function syncComposeLock() {
  const locked = Boolean(state.user) && !hasCauNumber();
  const form = els.postForm;
  if (!form) return;
  form.querySelectorAll('textarea, select, input, button[type="submit"]').forEach((el) => {
    el.disabled = locked;
  });
  form.setAttribute('aria-disabled', String(locked));
  els.composeLock?.classList.toggle('hidden', !locked);
}

function openCauModal() {
  if (!els.cauDialog) return;
  showFeedback(els.cauFeedback, '');
  if (!els.cauDialog.open) els.cauDialog.showModal();
  document.getElementById('cau-number')?.focus();
}

function maybePromptCau() {
  syncComposeLock();
  if (cauSaveInFlight) return;
  if (!state.user || hasCauNumber()) {
    if (els.cauDialog?.open) els.cauDialog.close();
    return;
  }
  if (!cauPromptShown) {
    cauPromptShown = true;
    openCauModal();
  }
}

function mensagemErroSalvarCau(raw, cau) {
  const text = String(raw || '');
  if (/vinculado a outra conta/i.test(text)) {
    return 'Este registro do CAU já está vinculado a outra conta.';
  }
  if (/PGRST202|schema cache|Could not find the function/i.test(text)) {
    return 'A validação do CAU ainda não está ativa no banco. Execute sql/cau-number.sql no SQL Editor do Supabase.';
  }
  if (/invalido/i.test(text) || /check constraint/i.test(text)) {
    return mensagemErroRegistroCAU(cau);
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
  const cau = normalizarRegistroCAU(input?.value);
  if (input) input.value = cau;

  if (!declaration?.checked) {
    showFeedback(els.cauFeedback, 'Confirme a declaração de arquiteto(a) e urbanista ativo(a) em Santa Catarina.', true);
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
    const saved = await persistCauNumber(cau);
    state.profile = { ...(state.profile || {}), cau_number: saved.cau_number || cau };
    showFeedback(els.cauFeedback, 'Registro do CAU validado e salvo.');
    announce('Registro do CAU validado.');
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
      <button type="button" id="btn-delete-mine" class="btn-text">Excluir minhas contribuições</button>
      <button type="button" id="btn-logout" class="btn btn-ghost">Sair</button>
    </div>
  `;
  document.getElementById('btn-logout')?.addEventListener('click', signOut);
  document.getElementById('btn-delete-mine')?.addEventListener('click', deleteMyContributions);
  els.composeBar.classList.remove('hidden');
  syncComposeLock();
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
}

async function signInWithGoogle() {
  const { error } = await state.supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
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
  let query = state.supabase.from('posts_feed').select('*');
  if (state.filterType !== 'todos') query = query.eq('type', state.filterType);
  query =
    state.sort === 'apoios'
      ? query.order('likes_count', { ascending: false }).order('created_at', { ascending: false })
      : query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) {
    showConfigBanner(`Não foi possível carregar o feed: ${escapeHtml(error.message)}`);
    els.feedEmpty.classList.remove('hidden');
    return;
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
  state.posts = posts;
  renderFeed();
  syncTopicButtons();
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

function renderFeed() {
  els.feed.innerHTML = '';
  if (!state.posts.length) {
    els.feedEmpty.classList.remove('hidden');
    return;
  }
  els.feedEmpty.classList.add('hidden');
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

  likeBtn.addEventListener('click', () => toggleLike(post, node));
  node.querySelector('[data-toggle-comments]').addEventListener('click', (event) => toggleComments(post.id, node, event.currentTarget));
  node.querySelector('[data-report]').addEventListener('click', () => openReport({ postId: post.id }));
  deleteOwn.addEventListener('click', () => deletePost(post.id, false));
  adminActions.querySelector('[data-admin-delete]')?.addEventListener('click', () => deletePost(post.id, true));
  commentForm.addEventListener('submit', (event) => submitComment(event, post.id, node));
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
    list.innerHTML = comments
      .map((comment) => {
        const hiddenNote = comment.is_hidden ? ' <span class="admin-tag">Oculto</span>' : '';
        const ownBtn = comment.is_own
          ? `<button type="button" class="btn-text" data-del-comment="${comment.id}">Excluir</button>`
          : '';
        const hideBtn = isAdmin()
          ? `<button type="button" class="btn-text" data-hide-comment="${comment.id}" data-hidden="${comment.is_hidden}">${comment.is_hidden ? 'Reexibir' : 'Ocultar'}</button>`
          : '';
        const reportBtn = state.user
          ? `<button type="button" class="btn-text" data-report-comment="${comment.id}">Denunciar</button>`
          : '';
        return `
          <article class="liquid-card comment-item ${comment.is_hidden ? 'opacity-70' : ''}">
            <p class="meta"><strong>${escapeHtml(comment.author_name)}</strong> · <time datetime="${comment.created_at}">${formatDate(comment.created_at)}</time>${hiddenNote}</p>
            <p class="mt-1 whitespace-pre-wrap text-sm">${escapeHtml(comment.content)}</p>
            <div class="mt-2 flex gap-3">${ownBtn}${hideBtn}${reportBtn}</div>
          </article>
        `;
      })
      .join('');

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
  } catch (error) {
    list.innerHTML = `<p class="feedback-error">${escapeHtml(error.message)}</p>`;
  }
}

async function submitPost(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!assertNotBot(form)) return;
  if (!hasCauNumber()) {
    showFeedback(els.postFeedback, 'Informe e valide o seu registro do CAU para publicar.', true);
    openCauModal();
    return;
  }
  if (!document.getElementById('post-lgpd').checked) {
    showFeedback(els.postFeedback, 'É necessário aceitar os Termos de Privacidade.', true);
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
    showFeedback(els.postFeedback, error.message, true);
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

async function submitComment(event, postId, card) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!assertNotBot(form)) return;
  const feedback = card.querySelector('[data-comment-feedback]');
  const lgpd = form.querySelector('[data-comment-lgpd]');
  if (!lgpd.checked) {
    showFeedback(feedback, 'É necessário aceitar os Termos de Privacidade.', true);
    return;
  }
  const content = form.querySelector('[data-comment-input]').value.trim();
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
  const { error } = await state.supabase.from('comments').insert({
    post_id: postId,
    content,
    is_anonymous: form.querySelector('[data-comment-anon]').checked,
    lgpd_consent: true,
  });
  if (error) {
    showFeedback(feedback, error.message, true);
    return;
  }
  markSubmitted();
  hideModerationAlert();
  form.reset();
  showFeedback(feedback, 'Comentário publicado.');
  await renderComments(postId, card);
  await loadPosts();
  await loadTrendingTopics();
}

async function deletePost(postId, asAdmin) {
  const ok = await confirmAction(
    asAdmin ? 'Deletar post (moderação)' : 'Excluir publicação',
    asAdmin
      ? 'Esta publicação será removida do debate. A ação é irreversível.'
      : 'Você está exercendo o direito de eliminação (art. 18 da LGPD). Continuar?',
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
  await loadPosts();
  await loadReports();
  await loadTrendingTopics();
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
  els.cauForm?.addEventListener('submit', submitCau);
  document.getElementById('cau-cancel')?.addEventListener('click', () => els.cauDialog.close());
  document.getElementById('btn-open-cau')?.addEventListener('click', openCauModal);
  document.getElementById('moderation-alert-close')?.addEventListener('click', hideModerationAlert);
  document.getElementById('cau-number')?.addEventListener('input', (event) => {
    const caret = event.target.selectionStart;
    const before = event.target.value;
    event.target.value = normalizarRegistroCAU(event.target.value);
    if (typeof caret === 'number') {
      const delta = event.target.value.length - before.length;
      event.target.setSelectionRange(caret + delta, caret + delta);
    }
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
}

init().catch((error) => {
  showConfigBanner(`Erro ao iniciar a aplicação: ${escapeHtml(error.message)}`);
});
