import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './js/config.js';

const RATE_LIMIT_MS = 3 * 60 * 1000;
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
};

function announce(message) {
  els.liveRegion.textContent = message;
}

function isAdmin() {
  return Boolean(state.profile?.is_admin);
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
    const minutes = Math.ceil(wait / 60000);
    throw new Error(`Aguarde ${minutes} min entre publicações e comentários (proteção anti-spam).`);
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
  node.className = `text-sm ${isError ? 'text-accent' : 'text-ink/80'}`;
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
    els.authSlot.innerHTML = `<span class="text-sm text-paper/80">Configure o Supabase para entrar</span>`;
    return;
  }

  if (!state.user) {
    els.authSlot.innerHTML = `
      <button type="button" id="btn-login" class="rounded bg-paper px-3 py-2 text-sm font-bold text-ink">
        Entrar com Google
      </button>
    `;
    document.getElementById('btn-login')?.addEventListener('click', openLogin);
    els.composeBar.classList.add('hidden');
    return;
  }

  const name = state.profile?.full_name || state.user.user_metadata?.name || 'Arquiteto(a)';
  const avatar = safeHttpUrl(
    state.profile?.avatar_url ||
      state.user.user_metadata?.avatar_url ||
      state.user.user_metadata?.picture ||
      '',
  );
  const adminTag = isAdmin()
    ? `<span class="stamp bg-paper/10 text-paper">Administrador</span>`
    : '';

  els.authSlot.innerHTML = `
    <div class="flex items-center gap-3">
      ${
        avatar
          ? `<img src="${avatar}" alt="" width="36" height="36" class="h-9 w-9 rounded-full object-cover" />`
          : ''
      }
      <div class="text-right">
        <p class="text-sm font-bold leading-tight">${escapeHtml(name)}</p>
        ${adminTag}
      </div>
      <button type="button" id="btn-delete-mine" class="text-xs underline text-paper/80">Excluir minhas contribuições</button>
      <button type="button" id="btn-logout" class="rounded border border-paper/40 px-3 py-1.5 text-sm">Sair</button>
    </div>
  `;
  document.getElementById('btn-logout')?.addEventListener('click', signOut);
  document.getElementById('btn-delete-mine')?.addEventListener('click', deleteMyContributions);
  els.composeBar.classList.remove('hidden');
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
  const { data, error } = await state.supabase.rpc('current_profile');
  if (error) {
    console.warn(error);
    state.profile = {
      id: state.user.id,
      full_name: state.user.user_metadata?.full_name || state.user.user_metadata?.name || 'Arquiteto(a)',
      avatar_url: state.user.user_metadata?.avatar_url || state.user.user_metadata?.picture,
      is_admin: false,
    };
    return;
  }
  state.profile = Array.isArray(data) ? data[0] : data;
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
    return;
  }
  state.posts = data || [];
  renderFeed();
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
    els.reportsList.innerHTML = `<p class="text-sm text-accent">${escapeHtml(error.message)}</p>`;
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
      <article class="rounded border border-line bg-white p-3 text-sm">
        <p><strong>Motivo:</strong> ${escapeHtml(report.reason)}</p>
        <p class="text-ink/70">${report.post_id ? 'Publicação' : 'Comentário'} · ${formatDate(report.created_at)} · ${escapeHtml(report.status)}</p>
        ${
          report.status === 'aberta'
            ? `<button type="button" class="mt-2 underline" data-review-report="${report.id}">Marcar como revisada</button>`
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
  badge.textContent = isIdeia ? 'Ideia' : 'Reclamação';
  badge.classList.add(isIdeia ? 'stamp-ideia' : 'stamp-reclamacao');
  node.querySelector('[data-author]').textContent = post.author_name;
  const time = node.querySelector('[data-date]');
  time.dateTime = post.created_at;
  time.textContent = formatDate(post.created_at);
  node.querySelector('[data-title]').textContent = post.title || (isIdeia ? 'Ideia' : 'Reclamação');
  node.querySelector('[data-content]').textContent = post.content;
  node.querySelector('[data-like-count]').textContent = post.likes_count ?? 0;
  node.querySelector('[data-comment-count]').textContent = post.comments_count ?? 0;
  node.dataset.postId = post.id;

  const likeBtn = node.querySelector('[data-like]');
  likeBtn.setAttribute('aria-pressed', post.liked_by_me ? 'true' : 'false');
  likeBtn.classList.toggle('bg-[#dcefe3]', Boolean(post.liked_by_me));
  if (!state.user) {
    likeBtn.title = 'Entre para apoiar';
  }

  const deleteOwn = node.querySelector('[data-delete-own]');
  if (post.is_own) deleteOwn.classList.remove('hidden');

  const adminActions = node.querySelector('[data-admin-actions]');
  if (isAdmin()) {
    adminActions.innerHTML = `<button type="button" data-admin-delete class="rounded bg-accent px-3 py-1.5 text-xs font-bold text-white">Deletar post</button>`;
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
        const hiddenNote = comment.is_hidden ? ' <span class="stamp stamp-reclamacao">Oculto</span>' : '';
        const ownBtn = comment.is_own
          ? `<button type="button" class="underline text-sm" data-del-comment="${comment.id}">Excluir</button>`
          : '';
        const hideBtn = isAdmin()
          ? `<button type="button" class="underline text-sm" data-hide-comment="${comment.id}" data-hidden="${comment.is_hidden}">${comment.is_hidden ? 'Reexibir' : 'Ocultar'}</button>`
          : '';
        const reportBtn = state.user
          ? `<button type="button" class="underline text-sm" data-report-comment="${comment.id}">Denunciar</button>`
          : '';
        return `
          <article class="rounded border border-line/70 bg-white p-3 ${comment.is_hidden ? 'opacity-70' : ''}">
            <p class="text-sm"><strong>${escapeHtml(comment.author_name)}</strong> · <time datetime="${comment.created_at}">${formatDate(comment.created_at)}</time>${hiddenNote}</p>
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
    list.innerHTML = `<p class="text-sm text-accent">${escapeHtml(error.message)}</p>`;
  }
}

async function submitPost(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!assertNotBot(form)) return;
  try {
    assertRateLimit();
  } catch (error) {
    showFeedback(els.postFeedback, error.message, true);
    return;
  }
  if (!document.getElementById('post-lgpd').checked) {
    showFeedback(els.postFeedback, 'É necessário aceitar os Termos de Privacidade.', true);
    return;
  }
  const content = document.getElementById('post-content').value.trim();
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
  form.reset();
  document.getElementById('post-type').value = type;
  showFeedback(els.postFeedback, 'Publicação enviada.');
  announce('Publicação enviada.');
  await loadPosts();
}

async function submitComment(event, postId, card) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!assertNotBot(form)) return;
  const feedback = card.querySelector('[data-comment-feedback]');
  try {
    assertRateLimit();
  } catch (error) {
    showFeedback(feedback, error.message, true);
    return;
  }
  const lgpd = form.querySelector('[data-comment-lgpd]');
  if (!lgpd.checked) {
    showFeedback(feedback, 'É necessário aceitar os Termos de Privacidade.', true);
    return;
  }
  const content = form.querySelector('[data-comment-input]').value.trim();
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
  form.reset();
  showFeedback(feedback, 'Comentário publicado.');
  await renderComments(postId, card);
  await loadPosts();
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
  state.user = session?.user ?? null;
  await loadProfile();
  if (state.user && localStorage.getItem('multipla_lgpd_ok') === '1') {
    await recordConsent().catch(() => {});
  }
  renderAuth();
  await loadPosts();
  await loadReports();
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
}

async function init() {
  if (!CONFIG_READY) {
    showConfigBanner(
      'Preencha <code>js/config.js</code> com a URL e a chave anon do Supabase e rode <code>script.sql</code> no SQL Editor. Sem a chave <code>service_role</code>.',
    );
    renderAuth();
    els.feedEmpty.classList.remove('hidden');
    els.feedEmpty.textContent = 'O feed aparece quando o projeto Supabase estiver ligado a este site.';
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
