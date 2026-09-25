// Банк задач «Вероятность и статистика» – веб-версия ИС для учителя
// Одностраничное приложение без сборки: Supabase JS + обычный JavaScript.
"use strict";

// Тип перехода по ссылке из письма (приглашение / сброс пароля) – запоминаем ДО создания клиента,
// потому что клиент сразу очищает адресную строку.
const AUTH_LINK_TYPE = new URLSearchParams(location.hash.slice(1)).get("type");

const cfg = window.APP_CONFIG || {};
// адрес проекта без лишнего хвоста (частая ошибка – скопировать …/rest/v1/)
cfg.SUPABASE_URL = String(cfg.SUPABASE_URL || "").trim().replace(/\/(rest|auth)\/v1\/?.*$/i, "").replace(/\/+$/, "");
const sb = window.supabase.createClient(cfg.SUPABASE_URL, String(cfg.SUPABASE_ANON_KEY || "").trim());
const P = window.PROMPTS;
const $app = document.getElementById("app");

const S = {                       // состояние приложения
  user: null, profile: null,
  sections: [], topics: [], taskTypes: [], commentTypes: [],
  classes: [], chains: [], usage: new Map(),   // task_id -> [{class_id, used_on}]
  filters: { q: "", section: "", topic: "", grade: "", diff: "", mine: false },
  ai: null,                       // текущая сессия работы с ИИ на странице задачи
};

// ------------------------------------------------------------------ утилиты
const dash = (t) => (t == null ? t : String(t).replace(/\u2014/g, "\u2013"));   // длинное тире → короткое
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("ru-RU") : "";
const stars = (n) => "●".repeat(n) + "○".repeat(5 - n);
const isAdmin = () => S.profile?.role === "admin";
const canEdit = (row) => row && (row.author_id === S.user.id || isAdmin());
const topicById = (id) => S.topics.find((t) => t.id === id);
const sectionById = (id) => S.sections.find((s) => s.id === id);
const className = (id) => S.classes.find((c) => c.id === id)?.name ?? "?";

function toast(msg, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3500);
}
async function q(promise) {             // выполнить запрос Supabase, показать ошибку
  const { data, error } = await promise;
  if (error) { console.error(error); toast("Ошибка: " + (error.message || error), true); throw error; }
  return data;
}
function form(el) { return Object.fromEntries(new FormData(el).entries()); }
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

// ------------------------------------------------------------------ вход
function renderLogin(msg = "") {
  $app.innerHTML = `
  <div class="auth">
    <h1>Банк задач<br><small>Вероятность и статистика</small></h1>
    <p class="muted">Вход только для учителей.</p>
    ${msg ? `<p class="note">${esc(msg)}</p>` : ""}
    <form id="login" class="stack">
      <label>Почта<input name="email" type="email" required autocomplete="username"></label>
      <label>Пароль<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn primary">Войти</button>
    </form>
    <p class="row"><button class="link" data-act="forgot">Забыли пароль?</button>
      <a href="#/register" class="link" style="margin-left:auto">Регистрация по коду доступа</a></p>
  </div>`;
  document.getElementById("login").onsubmit = async (e) => {
    e.preventDefault();
    const f = form(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.email, password: f.password });
    if (error) {
      const m = error.message || String(error);
      const ru = /invalid login credentials/i.test(m) ? "Неверная почта или пароль."
        : /email not confirmed/i.test(m) ? "Почта не подтверждена. Администратору: подтвердите пользователя в Supabase."
        : /fetch|network|load failed/i.test(m) ? "Нет связи с базой. Проверьте адрес проекта в config.js."
        : "Не удалось войти.";
      renderLogin(ru + " (" + m + ")");
    }
  };
}

const POLICY_HTML = `
    <div class="policy">
      <p>Сайт – исследовательский прототип информационной системы для учителей математики (МПГУ, Институт математики и информатики).</p>
      <p><b>Какие данные хранятся:</b> ваша электронная почта, ФИО и школа (по желанию), добавленные вами задачи и комментарии, названия ваших классов (например, «8А»), цепочки задач, отметки о выдаче, а также ваши запросы к ИИ-помощнику и оценки его ответов.</p>
      <p><b>Данные учеников не хранятся.</b> Не вносите в задачи и комментарии фамилии и другие сведения об учениках.</p>
      <p><b>Кто видит:</b> задачи и методические комментарии – общие для всех учителей системы (подписываются вашим именем). Ваша почта видна только администратору. Классы, цепочки и выдачи видите только вы.</p>
      <p><b>ИИ-помощник:</b> текст задачи и комментариев передаётся внешней языковой модели (GigaChat или другой). Ответ ИИ – черновик, он попадает в общую базу только после проверки учителем.</p>
      <p><b>Исследование:</b> обезличенная статистика работы с ИИ (сколько задач сгенерировано, оценки учителей) может использоваться в научных публикациях.</p>
      <p><b>Где хранится:</b> облачная база Supabase (серверы в ЕС). Удалить свой аккаунт и данные можно по запросу администратору.</p>
    </div>`;

function renderRegister(msg = "") {
  $app.innerHTML = `
  <div class="auth wide">
    <h1>Регистрация учителя</h1>
    <p class="muted">Код доступа сообщает организатор (например, на конференции). Подтверждать почту не нужно.</p>
    ${msg ? `<p class="note bad">${esc(msg)}</p>` : ""}
    <form id="reg" class="stack">
      <label>ФИО<input name="full_name" required autocomplete="name"></label>
      <label>Школа / организация (необязательно)<input name="school"></label>
      <label>Почта (будет логином)<input name="email" type="email" required autocomplete="username"></label>
      <label>Придумайте пароль (не короче 8 символов)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>Код доступа<input name="code" required autocomplete="off" autocapitalize="none"></label>
      <details><summary>Политика конфиденциальности</summary>${POLICY_HTML}</details>
      <label class="check"><input type="checkbox" name="ok" required> Я учитель (методист, студент педвуза) и согласен(на) с политикой конфиденциальности</label>
      <button class="btn primary">Зарегистрироваться</button>
    </form>
    <p><a href="#/" class="link">У меня уже есть аккаунт – войти</a></p>
  </div>`;
  document.getElementById("reg").onsubmit = async (e) => {
    e.preventDefault();
    const f = form(e.target);
    const btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Регистрируем…";
    S.registering = true;
    const { data, error } = await sb.auth.signUp({
      email: f.email.trim(), password: f.password,
      options: { data: { full_name: f.full_name.trim(), school: f.school.trim() } },
    });
    S.registering = false;
    if (error) {
      const m = error.message || String(error);
      return renderRegister(/already registered|already exists/i.test(m) ? "Эта почта уже зарегистрирована – войдите с паролем или нажмите «Забыли пароль?»."
        : /rate limit/i.test(m) ? "Слишком много регистраций за короткое время. Подождите минуту и попробуйте снова."
        : /password/i.test(m) ? "Пароль слишком простой: минимум 8 символов." : "Не удалось зарегистрироваться (" + m + ")");
    }
    if (!data.session) {
      return renderLogin("Аккаунт создан, но в Supabase включено подтверждение почты. Проверьте почту или попросите администратора выключить «Confirm email».");
    }
    await q(sb.rpc("accept_privacy_policy", { p_full_name: f.full_name.trim(), p_school: f.school.trim() }));
    const ok = (await sb.rpc("redeem_access_code", { p_code: f.code })).data;
    if (!ok) toast("Код доступа не подошёл – введите его ещё раз", true);
    location.hash = "#/tasks";
    boot(true);
  };
}

function renderNeedCode(msg = "") {
  const blocked = S.profile?.blocked;
  $app.innerHTML = `
  <div class="auth">
    <h1>${blocked ? "Доступ закрыт" : "Нужен код доступа"}</h1>
    ${blocked ? `<p>Администратор закрыл доступ для этого аккаунта. Если это ошибка – свяжитесь с организатором.</p>` : `
    <p class="muted">Аккаунт создан. Чтобы открыть банк задач, введите код доступа, который сообщил организатор.</p>
    ${msg ? `<p class="note bad">${esc(msg)}</p>` : ""}
    <form id="code" class="stack">
      <label>Код доступа<input name="code" required autocomplete="off" autocapitalize="none"></label>
      <button class="btn primary">Открыть доступ</button>
    </form>`}
    <button class="link" data-act="logout">Выйти</button>
  </div>`;
  const fm = document.getElementById("code");
  if (fm) fm.onsubmit = async (e) => {
    e.preventDefault();
    const ok = (await sb.rpc("redeem_access_code", { p_code: form(e.target).code })).data;
    if (ok) return boot(true);
    const { data: pr } = await sb.from("profiles").select("blocked").eq("id", S.user.id).single();
    if (pr) S.profile.blocked = pr.blocked;
    renderNeedCode("Код не подошёл, устарел или исчерпан. Проверьте написание.");
  };
}

function renderSetPassword(isInvite) {
  $app.innerHTML = `
  <div class="auth">
    <h1>${isInvite ? "Добро пожаловать!" : "Новый пароль"}</h1>
    <p class="muted">${isInvite ? "Придумайте пароль для входа в банк задач." : "Введите новый пароль."}</p>
    <form id="setpw" class="stack">
      <label>Пароль (не короче 8 символов)<input name="p1" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>Повторите пароль<input name="p2" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary">Сохранить</button>
    </form>
  </div>`;
  document.getElementById("setpw").onsubmit = async (e) => {
    e.preventDefault();
    const f = form(e.target);
    if (f.p1 !== f.p2) return toast("Пароли не совпадают", true);
    await q(sb.auth.updateUser({ password: f.p1 }));
    toast("Пароль сохранён");
    boot(true);
  };
}

function renderConsent() {
  $app.innerHTML = `
  <div class="auth wide">
    <h1>Политика конфиденциальности</h1>
    ${POLICY_HTML}
    <form id="consent" class="stack">
      <label>ФИО<input name="full_name" value="${esc(S.profile?.full_name?.includes("@") ? "" : S.profile?.full_name)}" required></label>
      <label>Школа (необязательно)<input name="school" value="${esc(S.profile?.school)}"></label>
      <label class="check"><input type="checkbox" name="ok" required> Я согласен(на) с политикой конфиденциальности и на обработку указанных данных</label>
      <button class="btn primary">Продолжить</button>
    </form>
    <button class="link" data-act="logout">Выйти</button>
  </div>`;
  document.getElementById("consent").onsubmit = async (e) => {
    e.preventDefault();
    const f = form(e.target);
    await q(sb.rpc("accept_privacy_policy", { p_full_name: f.full_name, p_school: f.school }));
    boot(true);
  };
}

// ------------------------------------------------------------------ загрузка
async function loadRefs() {
  const [sec, top, tt, ct] = await Promise.all([
    q(sb.from("sections").select("*").order("sort_order")),
    q(sb.from("topics").select("*").order("sort_order")),
    q(sb.from("task_types").select("*").order("id")),
    q(sb.from("comment_types").select("*").order("id")),
  ]);
  Object.assign(S, { sections: sec, topics: top, taskTypes: tt, commentTypes: ct });
}
async function loadMine() {
  const [cls, ch, us] = await Promise.all([
    q(sb.from("classes").select("*").eq("archived", false).order("grade").order("name")),
    q(sb.from("chains").select("*, chain_items(count)").eq("teacher_id", S.user.id).order("created_at", { ascending: false })),
    q(sb.from("task_usage").select("class_id, task_id, used_on")),
  ]);
  S.classes = cls; S.chains = ch;
  S.usage = new Map();
  for (const u of us) {
    if (!S.usage.has(u.task_id)) S.usage.set(u.task_id, []);
    const arr = S.usage.get(u.task_id);
    if (!arr.some((x) => x.class_id === u.class_id)) arr.push(u);
  }
}

let booted = false;
async function boot(force = false) {
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("ВАШ-ПРОЕКТ")) {
    $app.innerHTML = `<div class="auth"><h1>Нужна настройка</h1><p>Откройте файл <code>config.js</code> и вставьте адрес проекта Supabase и публичный ключ (anon key).</p></div>`;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { booted = false; return location.hash.startsWith("#/register") ? renderRegister() : renderLogin(); }
  if (!force && (AUTH_LINK_TYPE === "invite" || AUTH_LINK_TYPE === "recovery") && !boot.pwDone) {
    boot.pwDone = true;
    return renderSetPassword(AUTH_LINK_TYPE === "invite");
  }
  S.user = session.user;
  S.profile = await q(sb.from("profiles").select("id, full_name, school, role, consent_at, approved, blocked").eq("id", S.user.id).single());
  if (!S.profile.consent_at) return renderConsent();
  if (!S.profile.approved || S.profile.blocked) return renderNeedCode();
  if (location.hash.startsWith("#/register")) location.hash = "#/tasks";
  await loadRefs();
  await loadMine();
  booted = true;
  route();
}

sb.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") { boot.pwDone = true; renderSetPassword(false); }
  if (event === "SIGNED_OUT") { booted = false; S.user = null; renderLogin(); }
  if (event === "SIGNED_IN" && !booted && !S.registering) setTimeout(() => boot(), 0);
});

// ------------------------------------------------------------------ каркас
function shell(active, inner) {
  const nav = [
    ["#/tasks", "Банк задач"], ["#/new", "+ Задача"], ["#/variant", "Вариант"],
    ["#/chains", "Цепочки"], ["#/classes", "Мои классы"], ["#/drafts", "Черновики"], ["#/topics", "Темы"], ["#/research", "ИИ: статистика"],
    ...(isAdmin() ? [["#/admin", "Учителя"]] : []),
  ];
  $app.innerHTML = `
  <header class="top">
    <a class="brand" href="#/tasks">Вероятность и статистика <span>банк задач</span></a>
    <nav>${nav.map(([h, t]) => `<a href="${h}" class="${active === h ? "on" : ""}">${t}</a>`).join("")}</nav>
    <div class="me">${esc(S.profile.full_name)}${isAdmin() ? ' <span class="tag">админ</span>' : ""} <button class="link" data-act="logout">Выйти</button></div>
  </header>
  <main>${inner}</main>`;
}

async function route() {
  if (!booted) return;
  const [, page, id, extra] = (location.hash || "#/tasks").split("/");
  try {
    switch (page) {
      case "task": return await pageTask(+id);
      case "new": return pageEdit(null);
      case "edit": return await pageEdit(+id);
      case "variant": return pageVariant();
      case "chains": return await pageChains(id);
      case "chain": return await pageChain(+id);
      case "print": return await pagePrint(+id, extra);
      case "classes": return await pageClasses(id ? +id : null);
      case "drafts": return await pageDrafts();
      case "research": return await pageResearch();
      case "admin": return await pageAdmin();
      case "topics": return await pageTopics();
      default: return await pageTasks();
    }
  } catch (e) { console.error(e); }
}
window.addEventListener("hashchange", () => {
  if (booted) return route();
  if (!S.user) location.hash.startsWith("#/register") ? renderRegister() : renderLogin();
});

// ------------------------------------------------------------------ выбор раздела/темы
function sectionOptions(sel) {
  return `<option value="">Все разделы</option>` + S.sections.map((s) => `<option value="${s.id}" ${+sel === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("");
}
function topicOptions(section, sel, allLabel = "Все темы") {
  const list = S.topics.filter((t) => !section || t.section_id === +section);
  return (allLabel ? `<option value="">${allLabel}</option>` : "") + list.map((t) =>
    `<option value="${t.id}" ${+sel === t.id ? "selected" : ""}>${esc(t.name)}${t.grade ? ` (${t.grade} кл.)` : ""}</option>`).join("");
}
const NEW_TOPIC = "__new";
function topicOptionsWithNew(section, sel) {
  return topicOptions(section, sel, "– выберите –") + `<option value="${NEW_TOPIC}">+ новая тема…</option>`;
}
async function createTopic(sectionId, grade) {
  if (!sectionId) { toast("Сначала выберите раздел", true); return null; }
  const name = (prompt(`Название новой темы в разделе «${sectionById(+sectionId)?.name}»:`) || "").trim();
  if (!name) return null;
  const same = S.topics.find((t) => t.section_id === +sectionId && t.name.trim().toLowerCase() === name.toLowerCase());
  if (same) { toast("Такая тема уже есть – выбрал её"); return same.id; }
  const { data, error } = await sb.from("topics").insert({
    section_id: +sectionId, name, grade: grade ? +grade : null,
    sort_order: 100 + S.topics.filter((t) => t.section_id === +sectionId).length,
  }).select().single();
  if (error) { toast(/duplicate|unique/i.test(error.message) ? "Такая тема уже есть в этом разделе" : "Ошибка: " + error.message, true); return null; }
  await loadRefs();
  toast(`Тема «${name}» добавлена – её видят все учителя`);
  return data.id;
}

function usageBadges(taskId) {
  const u = S.usage.get(taskId) || [];
  return u.map((x) => `<span class="badge used" title="Выдавалась ${fmtDate(x.used_on)}">${esc(className(x.class_id))} ✓</span>`).join("");
}

// ------------------------------------------------------------------ банк задач
async function pageTasks() {
  const f = S.filters;
  shell("#/tasks", `
    <section class="filters">
      <input id="fq" placeholder="Поиск по тексту условия…" value="${esc(f.q)}">
      <select id="fsec">${sectionOptions(f.section)}</select>
      <select id="ftop">${topicOptions(f.section, f.topic)}</select>
      <select id="fgr"><option value="">Любой класс</option>${[7, 8, 9, 10, 11].map((g) => `<option ${+f.grade === g ? "selected" : ""}>${g}</option>`).join("")}</select>
      <select id="fdf"><option value="">Любая сложность</option>${[1, 2, 3, 4, 5].map((d) => `<option ${+f.diff === d ? "selected" : ""}>${d}</option>`).join("")}</select>
      <label class="check"><input type="checkbox" id="fmine" ${f.mine ? "checked" : ""}> мои</label>
    </section>
    <div id="list" class="muted">Загрузка…</div>`);
  const upd = () => {
    Object.assign(f, {
      q: fq.value.trim(), section: fsec.value, topic: ftop.value, grade: fgr.value, diff: fdf.value, mine: fmine.checked,
    });
    loadList();
  };
  const fq = document.getElementById("fq"), fsec = document.getElementById("fsec"), ftop = document.getElementById("ftop"),
    fgr = document.getElementById("fgr"), fdf = document.getElementById("fdf"), fmine = document.getElementById("fmine");
  fsec.onchange = () => { ftop.innerHTML = topicOptions(fsec.value, ""); upd(); };
  [ftop, fgr, fdf, fmine].forEach((el) => (el.onchange = upd));
  fq.oninput = () => { clearTimeout(upd._t); upd._t = setTimeout(upd, 300); };
  loadList();
}

async function loadList() {
  const f = S.filters;
  let query = sb.from("tasks")
    .select("id, grade, difficulty, condition, status, origin, author_id, topic_id, task_comments(count)")
    .eq("status", "published").order("grade").order("difficulty").order("id");
  if (f.q) query = query.ilike("condition", `%${f.q}%`);
  if (f.topic) query = query.eq("topic_id", +f.topic);
  else if (f.section) query = query.in("topic_id", S.topics.filter((t) => t.section_id === +f.section).map((t) => t.id));
  if (f.grade) query = query.eq("grade", +f.grade);
  if (f.diff) query = query.eq("difficulty", +f.diff);
  if (f.mine) query = query.eq("author_id", S.user.id);
  const rows = await q(query);
  const list = document.getElementById("list");
  if (!list) return;
  list.className = "";
  list.innerHTML = rows.length ? `<p class="muted">Найдено задач: ${rows.length}</p>` + rows.map(taskCard).join("") :
    `<p class="muted">Ничего не найдено. <a href="#/new">Добавить задачу</a></p>`;
}

function taskCard(t) {
  const top = topicById(t.topic_id);
  const nComm = t.task_comments?.[0]?.count ?? 0;
  return `
  <a class="card" href="#/task/${t.id}">
    <div class="meta">
      <span>№${t.id}</span><span>${t.grade} класс</span><span title="Сложность ${t.difficulty} из 5">${stars(t.difficulty)}</span>
      <span>${esc(top?.name)}</span>${t.origin === "ai" ? '<span class="badge ai">аналог от ИИ, проверен</span>' : ""}
      ${nComm ? `<span class="badge">комментариев: ${nComm}</span>` : ""}${usageBadges(t.id)}
    </div>
    <div class="cond clamp">${esc(t.condition)}</div>
  </a>`;
}

// ------------------------------------------------------------------ страница задачи
async function loadTaskFull(id) {
  return q(sb.from("tasks").select(`*, task_types(name),
      author:profiles!tasks_author_id_fkey(full_name), verifier:profiles!tasks_verified_by_fkey(full_name),
      task_comments(id, body, status, origin, author_id, comment_type_id, created_at, author:profiles!task_comments_author_id_fkey(full_name))`)
    .eq("id", id).single());
}

function aiContext(t) {
  const top = topicById(t.topic_id);
  return {
    condition: t.condition, solution: t.solution, answer: t.answer, grade: t.grade, difficulty: t.difficulty,
    topic: top?.name ?? "", section: sectionById(top?.section_id)?.name ?? "",
    comments: (t.task_comments || []).filter((c) => c.status === "published")
      .map((c) => ({ type: S.commentTypes.find((k) => k.id === c.comment_type_id)?.name ?? "", body: c.body })),
  };
}

async function pageTask(id) {
  const t = await loadTaskFull(id);
  const [analogs, flags, parent] = await Promise.all([
    q(sb.from("tasks").select("id, condition, status, grade, difficulty").eq("parent_task_id", id)),
    q(sb.from("class_task_flags").select("*").eq("task_id", id)),
    t.parent_task_id ? q(sb.from("tasks").select("id, condition").eq("id", t.parent_task_id).maybeSingle()) : null,
  ]);
  const top = topicById(t.topic_id);
  const errType = S.commentTypes.find((c) => c.name === "Замечание об ошибке");
  const errCount = errType ? t.task_comments.filter((c) => c.comment_type_id === errType.id).length : 0;
  const byType = S.commentTypes.map((ct) => ({ ct, items: t.task_comments.filter((c) => c.comment_type_id === ct.id) }))
    .filter((g) => g.items.length);
  const FLAGS = { used: "давали", planned: "планирую", difficult: "трудная", favorite: "избранное" };

  shell("#/tasks", `
    <p><a href="#/tasks">← к банку задач</a></p>
    ${errCount ? `<p class="note bad">К этой задаче есть замечания об ошибке (${errCount}) – см. ниже, в комментариях.${canEdit(t) ? " Исправьте задачу и удалите замечание." : ""}</p>` : ""}
    <article class="task">
      <div class="meta">
        <span>№${t.id}</span><span>${t.grade} класс</span><span>сложность ${stars(t.difficulty)}</span>
        <span>${esc(sectionById(top?.section_id)?.name)} → ${esc(top?.name)}</span>
        ${t.task_types ? `<span>${esc(t.task_types.name)}</span>` : ""}
        ${t.status === "draft" ? '<span class="badge warn">черновик</span>' : ""}
        ${t.origin === "ai" ? `<span class="badge ai">создана ИИ${t.verifier ? ", проверил(а) " + esc(t.verifier.full_name) : ""}</span>` : ""}
      </div>
      <h2>Условие</h2><div class="cond">${esc(t.condition)}</div>
      <details ${t.solution ? "" : "open"}><summary>Решение${t.answer ? " и ответ" : ""}</summary>
        ${t.solution ? `<div class="cond">${esc(t.solution)}</div>` : '<p class="muted">Решения пока нет – можно попросить черновик у ИИ-помощника ниже.</p>'}
        ${t.answer ? `<p><b>Ответ:</b> ${esc(t.answer)}</p>` : ""}
      </details>
      <p class="muted small">Источник: ${esc(t.source || (t.author ? "добавил(а) " + t.author.full_name : "–"))} · ${fmtDate(t.created_at)}
        ${parent ? ` · аналог задачи <a href="#/task/${parent.id}">№${parent.id}</a>` : ""}</p>
      <div class="row">
        ${canEdit(t) ? `<a class="btn" href="#/edit/${t.id}">Редактировать</a>` : ""}
        ${errType ? `<button class="btn" data-act="reporterr">Сообщить об ошибке</button>` : ""}
        <select id="chainSel"><option value="">Добавить в цепочку…</option>${S.chains.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("")}<option value="new">+ новая цепочка</option></select>
      </div>
    </article>

    <section class="panel">
      <h2>Мои классы</h2>
      ${S.classes.length ? `<table class="flags"><tr><th></th>${Object.values(FLAGS).map((x) => `<th>${x}</th>`).join("")}</tr>
        ${S.classes.map((c) => `<tr><td><b>${esc(c.name)}</b></td>${Object.keys(FLAGS).map((fk) => {
          const on = flags.some((x) => x.class_id === c.id && x.flag === fk);
          return `<td><input type="checkbox" data-act="flag" data-class="${c.id}" data-flag="${fk}" ${on ? "checked" : ""}></td>`;
        }).join("")}</tr>`).join("")}</table>
        <p class="small muted">${usageBadges(t.id) || "Этой задачи ещё не было ни в одной выдаче."}</p>`
      : `<p class="muted">Классов пока нет. <a href="#/classes">Добавить классы</a></p>`}
    </section>

    <section class="panel">
      <h2>Методические комментарии</h2>
      ${byType.length ? byType.map((g) => `<h3>${esc(g.ct.name)}</h3>${g.items.map((c) => `
        <div class="comment ${c.status === "draft" ? "draft" : ""} ${errType && c.comment_type_id === errType.id ? "error" : ""}" id="cm${c.id}"><div class="cond">${esc(c.body.trim())}</div><div class="small muted">${c.author ? esc(c.author.full_name) : "из исходной базы"}${c.origin === "ai" ? " · черновик ИИ" : ""}${c.status === "draft" ? " · не опубликован" : ""}
          ${c.author_id === S.user.id ? ` · <button class="link" data-act="editcomment" data-id="${c.id}">изменить</button>` : ""}
          ${canEdit(c) || (errType && c.comment_type_id === errType.id && canEdit(t)) ? ` · <button class="link" data-act="delcomment" data-id="${c.id}">${errType && c.comment_type_id === errType.id && c.author_id !== S.user.id ? "исправлено – убрать" : "удалить"}</button>` : ""}</div>
        </div>`).join("")}`).join("") : '<p class="muted">Комментариев пока нет.</p>'}
      <form id="addComment" class="row">
        <select name="type">${S.commentTypes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        <textarea name="body" rows="2" placeholder="Поделитесь опытом: частая ошибка, пример из жизни, вопрос ученику…" required></textarea>
        <button class="btn">Добавить</button>
      </form>
    </section>

    ${analogs.length ? `<section class="panel"><h2>Аналоги этой задачи</h2>${analogs.map((a) =>
      `<p><a href="#/task/${a.id}">№${a.id}</a> ${a.status === "draft" ? '<span class="badge warn">черновик</span>' : ""} ${esc(a.condition.slice(0, 140))}…</p>`).join("")}</section>` : ""}

    <section class="panel ai-panel" id="aiPanel">
      <h2>ИИ-помощник учителя</h2>
      <p class="small muted">Запрос к ИИ собирается из этой задачи и методических комментариев учителей. Результат – черновик: он попадёт в общий банк только после вашей проверки.</p>
      <div class="kinds">${Object.entries(P.KINDS).map(([k, v], i) =>
        `<label class="kind"><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""}><b>${v.title}</b><span>${v.hint}</span></label>`).join("")}</div>
      <div class="row">
        <label>Сколько задач <input id="aiCount" type="number" min="1" max="5" value="3" style="width:4em"></label>
        <label class="check" title="Для эксперимента: сравнить ответы ИИ с контекстом базы и без него"><input type="checkbox" id="aiCtx" checked> передать методический контекст из базы</label>
      </div>
      <div class="row">
        <button class="btn primary" data-act="ai-api">Спросить ИИ</button>
        <button class="btn" data-act="ai-copy">Скопировать запрос для любого чата</button>
      </div>
      <div id="aiOut"></div>
    </section>`);

  // обработчики
  const chainSel = document.getElementById("chainSel");
  chainSel.onchange = async () => {
    let chainId = chainSel.value;
    if (!chainId) return;
    if (chainId === "new") {
      const title = prompt("Название новой цепочки:");
      if (!title) { chainSel.value = ""; return; }
      chainId = (await q(sb.from("chains").insert({ title }).select().single())).id;
    }
    const items = await q(sb.from("chain_items").select("position, task_id").eq("chain_id", +chainId));
    if (items.some((i) => i.task_id === t.id)) { toast("Задача уже есть в этой цепочке"); chainSel.value = ""; return; }
    const pos = Math.max(0, ...items.map((i) => i.position)) + 1;
    await q(sb.from("chain_items").insert({ chain_id: +chainId, position: pos, task_id: t.id }));
    await loadMine();
    toast(`Добавлено в цепочку (позиция ${pos})`);
    chainSel.value = "";
  };
  document.getElementById("addComment").onsubmit = async (e) => {
    e.preventDefault();
    const f = form(e.target);
    await q(sb.from("task_comments").insert({ task_id: t.id, comment_type_id: +f.type, body: dash(f.body.trim()), author_id: S.user.id }));
    toast("Комментарий добавлен"); pageTask(t.id);
  };
  S.ai = { task: t, gen: null, kind: null, parsed: null };
  const kindRadios = [...document.querySelectorAll('input[name="kind"]')];
  const cnt = document.getElementById("aiCount");
  const syncCount = () => (cnt.disabled = !P.KINDS[kindRadios.find((r) => r.checked).value].multi);
  kindRadios.forEach((r) => (r.onchange = syncCount)); syncCount();
}

// ------------------------------------------------------------------ ИИ
function aiRequest() {
  const t = S.ai.task;
  const kind = document.querySelector('input[name="kind"]:checked').value;
  const withContext = document.getElementById("aiCtx").checked;
  const count = Math.min(5, Math.max(1, +document.getElementById("aiCount").value || 3));
  if ((kind === "check") && !t.solution) { toast("У задачи нет решения – нечего проверять. Выберите «Решение».", true); return null; }
  const userPrompt = P.build(kind, aiContext(t), withContext, count);
  return { kind, withContext, userPrompt, full: P.SYSTEM + "\n\n" + userPrompt };
}

async function aiApi() {
  const r = aiRequest(); if (!r) return;
  const out = document.getElementById("aiOut");
  out.innerHTML = `<p class="muted">ИИ думает… (обычно 10–40 секунд)</p>`;
  const gen = await q(sb.from("ai_generations").insert({ task_id: S.ai.task.id, kind: r.kind, mode: "api", with_context: r.withContext, prompt: r.full }).select().single());
  const { data, error } = await sb.functions.invoke("ai-assistant", { body: { system: P.SYSTEM, prompt: r.userPrompt } });
  if (error || data?.error) {
    let msg = data?.error || error?.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* нет тела */ }
    out.innerHTML = `<p class="note bad">Встроенный ИИ сейчас недоступен (${esc(msg)}).<br>
      Воспользуйтесь кнопкой «Скопировать запрос для любого чата» – это работает всегда.</p>`;
    await sb.from("ai_generations").update({ teacher_note: "ошибка: " + msg }).eq("id", gen.id);
    return;
  }
  await q(sb.from("ai_generations").update({ response: data.text, model: data.model }).eq("id", gen.id));
  Object.assign(S.ai, { gen: { ...gen, model: data.model }, kind: r.kind });
  showAiResult(data.text, data.model);
}

async function aiCopy() {
  const r = aiRequest(); if (!r) return;
  try { await navigator.clipboard.writeText(r.full); toast("Запрос скопирован. Вставьте его в DeepSeek, GigaChat или другой чат."); }
  catch { toast("Не удалось скопировать автоматически – выделите текст ниже вручную."); }
  const gen = await q(sb.from("ai_generations").insert({ task_id: S.ai.task.id, kind: r.kind, mode: "copy", with_context: r.withContext, prompt: r.full }).select().single());
  Object.assign(S.ai, { gen, kind: r.kind });
  document.getElementById("aiOut").innerHTML = `
    <details><summary>Текст запроса</summary><textarea readonly rows="10" class="mono">${esc(r.full)}</textarea></details>
    <ol class="small"><li>Откройте любой ИИ-чат (например, chat.deepseek.com или giga.chat).</li>
      <li>Вставьте запрос (Ctrl+V) и отправьте.</li><li>Скопируйте весь ответ и вставьте сюда:</li></ol>
    <label>Какой ИИ вы использовали? <input id="pasteModel" placeholder="DeepSeek / GigaChat / Алиса…"></label>
    <textarea id="pasteText" rows="8" placeholder="Ответ ИИ…"></textarea>
    <button class="btn primary" data-act="ai-paste">Разобрать ответ</button>`;
}

async function aiPaste() {
  const text = document.getElementById("pasteText").value.trim();
  const model = document.getElementById("pasteModel").value.trim() || "чат (вручную)";
  if (!text) return toast("Вставьте ответ ИИ", true);
  await q(sb.from("ai_generations").update({ response: text, model }).eq("id", S.ai.gen.id));
  S.ai.gen.model = model;
  showAiResult(text, model);
}

function showAiResult(text, model) {
  text = dash(text);
  const data = P.parse(text);
  S.ai.parsed = data;
  const t = S.ai.task, k = S.ai.kind;
  let body = "";
  if (!data) {
    body = `<p class="note">Не удалось разобрать ответ как JSON – показываю как есть. Можно скопировать нужное вручную.</p><div class="cond">${esc(text)}</div>`;
  } else if (k === "analog" || k === "diagnostic") {
    body = (data.tasks || []).map((x, i) => `
      <div class="gen">
        <h3>Вариант ${i + 1}</h3>
        <div class="cond">${esc(x.condition)}</div>
        <details><summary>Решение и ответ</summary><div class="cond">${esc(x.solution)}</div><p><b>Ответ:</b> ${esc(x.answer)}</p>
        ${x.wrong_answer ? `<p><b>Ответ при типичной ошибке:</b> ${esc(x.wrong_answer)}</p>` : ""}</details>
        ${x.trap ? `<p class="small"><b>Выявляет ошибку:</b> ${esc(x.trap)}</p>` : ""}
        <button class="btn" data-act="ai-save-task" data-i="${i}">Сохранить в черновики</button>
      </div>`).join("");
  } else if (k === "solution") {
    body = `<div class="cond">${esc(data.solution)}</div><p><b>Ответ:</b> ${esc(data.answer)}</p>
      ${canEdit(t) ? `<button class="btn" data-act="ai-apply-solution">Я проверил(а) – записать в задачу</button>` :
        `<button class="btn" data-act="ai-solution-comment">Сохранить как методическую справку (черновик)</button>`}`;
  } else if (k === "comments") {
    body = (data.comments || []).map((c, i) => `
      <div class="gen"><b>${esc(c.type)}</b><div class="cond">${esc(c.body)}</div>
      <button class="btn" data-act="ai-save-comment" data-i="${i}">Сохранить в черновики</button></div>`).join("");
  } else if (k === "check") {
    body = `<p class="note ${data.correct ? "" : "bad"}"><b>${data.correct ? "ИИ считает решение верным." : "ИИ нашёл возможную ошибку."}</b></p>
      ${data.issues ? `<p>${esc(data.issues)}</p>` : ""}
      ${!data.correct && data.fixed_solution ? `<h3>Предложенное исправление</h3><div class="cond">${esc(data.fixed_solution)}</div><p><b>Ответ:</b> ${esc(data.fixed_answer)}</p>
        ${canEdit(t) ? `<button class="btn" data-act="ai-apply-fix">Я проверил(а) – исправить задачу</button>` : `<p class="small muted">Исправить задачу может её автор или администратор – оставьте комментарий.</p>`}` : ""}`;
  }
  document.getElementById("aiOut").innerHTML = `
    <div class="ai-result"><p class="small muted">Модель: ${esc(model)}</p>${body}
    <div class="rate"><b>Оцените полезность ответа:</b> ${[1, 2, 3, 4, 5].map((n) => `<button class="star" data-act="ai-rate" data-n="${n}">${n}</button>`).join("")}
      <input id="rateNote" placeholder="Комментарий (необязательно): что не так, что понравилось"></div></div>`;
}

async function aiSaveTask(i) {
  const x = S.ai.parsed.tasks[i], t = S.ai.task;
  const row = await q(sb.from("tasks").insert({
    topic_id: t.topic_id, task_type_id: t.task_type_id, grade: t.grade, difficulty: t.difficulty,
    condition: x.condition, solution: x.solution + (x.wrong_answer ? `\n\nОтвет при типичной ошибке: ${x.wrong_answer}` : ""), answer: x.answer,
    source: `ИИ (${S.ai.gen.model || "модель"}) по задаче №${t.id}`, author_id: S.user.id,
    origin: "ai", status: "draft", parent_task_id: t.id,
  }).select().single());
  if (x.trap) {
    const ct = S.commentTypes.find((c) => c.name === "Частая ошибка ученика");
    await q(sb.from("task_comments").insert({ task_id: row.id, comment_type_id: ct.id, body: x.trap, author_id: S.user.id, origin: "ai", status: "draft" }));
  }
  await sb.from("ai_generations").update({ result_task_id: row.id }).eq("id", S.ai.gen.id);
  toast(`Сохранено как черновик №${row.id}. Проверьте его в разделе «Черновики».`);
}
async function aiSaveComment(typeName, body) {
  const ct = S.commentTypes.find((c) => c.name.toLowerCase() === String(typeName).toLowerCase().replace(/[«»"]/g, "").trim())
    || S.commentTypes.find((c) => c.name === "Методическая справка");
  await q(sb.from("task_comments").insert({ task_id: S.ai.task.id, comment_type_id: ct.id, body, author_id: S.user.id, origin: "ai", status: "draft" }));
  toast("Комментарий сохранён в черновики");
}

// ------------------------------------------------------------------ добавление / редактирование
async function pageEdit(id) {
  const t = id ? await loadTaskFull(id) : { grade: 8, difficulty: 2, topic_id: "", task_type_id: 2 };
  if (id && !canEdit(t)) { toast("Редактировать может только автор задачи", true); return go("#/task/" + id); }
  const sec = t.topic_id ? topicById(t.topic_id)?.section_id : "";
  shell(id ? "" : "#/new", `
    <h1>${id ? "Редактирование задачи №" + id : "Новая задача"}</h1>
    <form id="ed" class="stack narrow">
      <div class="row">
        <label>Раздел<select id="esec">${sectionOptions(sec).replace("Все разделы", "– выберите –")}</select></label>
        <label>Тема<select name="topic_id" id="etop" required>${topicOptionsWithNew(sec, t.topic_id)}</select></label>
      </div>
      <div class="row">
        <label>Класс<select name="grade">${[7, 8, 9, 10, 11].map((g) => `<option ${t.grade === g ? "selected" : ""}>${g}</option>`).join("")}</select></label>
        <label>Сложность (1–5)<select name="difficulty">${[1, 2, 3, 4, 5].map((d) => `<option ${t.difficulty === d ? "selected" : ""}>${d}</option>`).join("")}</select></label>
        <label>Тип<select name="task_type_id">${S.taskTypes.map((x) => `<option value="${x.id}" ${t.task_type_id === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
      </div>
      <label>Условие<textarea name="condition" rows="6" required>${esc(t.condition)}</textarea></label>
      <label>Решение<textarea name="solution" rows="6">${esc(t.solution)}</textarea></label>
      <label>Краткий ответ<input name="answer" value="${esc(t.answer)}"></label>
      <label>Источник (учебник, автор)<input name="source" value="${esc(t.source)}" placeholder="например: Высоцкий И.Р., Ященко И.В., № 123"></label>
      <div class="row"><button class="btn primary">Сохранить</button>
        ${id ? `<button type="button" class="btn danger" data-act="deltask" data-id="${id}">Удалить задачу</button>` : ""}</div>
    </form>`);
  const esec = document.getElementById("esec"), etop = document.getElementById("etop");
  esec.onchange = () => (etop.innerHTML = topicOptionsWithNew(esec.value, ""));
  let prevTopic = etop.value;
  etop.onchange = async () => {
    if (etop.value !== NEW_TOPIC) { prevTopic = etop.value; return; }
    const grade = document.querySelector('#ed select[name="grade"]').value;
    const id = await createTopic(esec.value, grade);
    etop.innerHTML = topicOptionsWithNew(esec.value, id ?? prevTopic);
    if (id) prevTopic = String(id);
  };
  document.getElementById("ed").onsubmit = async (e) => {
    e.preventDefault();
    const f = form(e.target);
    if (!f.topic_id || f.topic_id === NEW_TOPIC) return toast("Выберите тему", true);
    const row = {
      topic_id: +f.topic_id, grade: +f.grade, difficulty: +f.difficulty, task_type_id: +f.task_type_id,
      condition: dash(f.condition.trim()), solution: dash(f.solution.trim()) || null, answer: dash(f.answer.trim()) || null, source: dash(f.source.trim()) || null,
    };
    if (id) { await q(sb.from("tasks").update(row).eq("id", id)); toast("Сохранено"); go("#/task/" + id); }
    else {
      const r = await q(sb.from("tasks").insert({ ...row, author_id: S.user.id }).select().single());
      toast("Задача добавлена в общий банк"); go("#/task/" + r.id);
    }
  };
}

// ------------------------------------------------------------------ мои классы
async function pageClasses(openId) {
  const all = await q(sb.from("classes").select("*").order("archived").order("grade").order("name"));
  let detail = "";
  if (openId) {
    const used = (await q(sb.from("task_usage").select("task_id, used_on, via").eq("class_id", openId).order("used_on", { ascending: false })));
    const ids = [...new Set(used.map((u) => u.task_id))];
    const tasks = ids.length ? await q(sb.from("tasks").select("id, condition, difficulty").in("id", ids)) : [];
    detail = `<section class="panel"><h2>Класс ${esc(all.find((c) => c.id === openId)?.name)}: выданные задачи (${ids.length})</h2>
      ${tasks.map((t) => `<p><a href="#/task/${t.id}">№${t.id}</a> ${stars(t.difficulty)} ${esc(t.condition.slice(0, 120))}…
        <span class="small muted">${fmtDate(used.find((u) => u.task_id === t.id).used_on)}</span></p>`).join("") || '<p class="muted">Пока ничего не выдавалось.</p>'}</section>`;
  }
  shell("#/classes", `
    <h1>Мои классы</h1>
    <p class="muted small">Классы видите только вы. Данные учеников не храним – только название класса.</p>
    <table class="tbl"><tr><th>Класс</th><th>Параллель</th><th>Учебный год</th><th>Выдано задач</th><th></th></tr>
    ${all.map((c) => {
      const n = [...S.usage.values()].filter((arr) => arr.some((u) => u.class_id === c.id)).length;
      return `<tr class="${c.archived ? "muted" : ""}"><td><a href="#/classes/${c.id}"><b>${esc(c.name)}</b></a></td><td>${c.grade}</td><td>${esc(c.school_year)}</td><td>${n}</td>
        <td><button class="link" data-act="archclass" data-id="${c.id}" data-v="${!c.archived}">${c.archived ? "вернуть" : "в архив"}</button></td></tr>`;
    }).join("") || '<tr><td colspan="5" class="muted">Классов пока нет</td></tr>'}</table>
    <form id="addClass" class="row">
      <input name="name" placeholder="Название, например 8А" required>
      <select name="grade">${[7, 8, 9, 10, 11].map((g) => `<option>${g}</option>`).join("")}</select>
      <button class="btn primary">Добавить класс</button>
    </form>${detail}`);
  document.getElementById("addClass").onsubmit = async (e) => {
    e.preventDefault(); const f = form(e.target);
    await q(sb.from("classes").insert({ name: f.name.trim(), grade: +f.grade }));
    await loadMine(); pageClasses();
  };
}

// ------------------------------------------------------------------ цепочки
async function pageChains(tab) {
  await loadMine();
  const shared = tab === "shared" ? await q(sb.rpc("shared_chains")) : null;
  shell("#/chains", `
    <h1>Цепочки задач</h1>
    <p class="muted small">Цепочка – набор задач в нужном порядке (например, от простой к сложной). Её можно выдать классу, распечатать и поделиться с коллегами.</p>
    <div class="row tabs"><a class="btn ${shared ? "" : "primary"}" href="#/chains">Мои (${S.chains.length})</a><a class="btn ${shared ? "primary" : ""}" href="#/chains/shared">Общие – от коллег</a></div>
    ${shared ? (shared.map((c) => `<a class="card" href="#/chain/${c.id}"><b>${esc(c.title)}</b>
        <span class="muted small"> · ${c.mine ? "ваша" : esc(c.author)} · задач: ${c.tasks} · скопировали: ${c.copies} · ${fmtDate(c.shared_at)}</span>
        ${c.description ? `<div class="small">${esc(c.description)}</div>` : ""}</a>`).join("")
        || '<p class="muted">Пока никто не поделился цепочкой. Откройте свою цепочку и нажмите «Поделиться с коллегами».</p>')
    : `${S.chains.map((c) => `<a class="card" href="#/chain/${c.id}"><b>${esc(c.title)}</b>
       <span class="muted small"> · задач: ${c.chain_items?.[0]?.count ?? 0} · ${fmtDate(c.created_at)}</span>
       ${c.shared ? '<span class="badge used">общая</span>' : ""}${c.copied_from ? '<span class="badge">копия</span>' : ""}</a>`).join("") || '<p class="muted">Цепочек пока нет.</p>'}
    <form id="addChain" class="row"><input name="title" placeholder="Название цепочки" required><button class="btn primary">Создать</button></form>`}`);
  const ac = document.getElementById("addChain");
  if (ac) ac.onsubmit = async (e) => {
    e.preventDefault();
    const r = await q(sb.from("chains").insert({ title: form(e.target).title.trim() }).select().single());
    go("#/chain/" + r.id);
  };
}

async function loadChain(id) {
  const chain = await q(sb.from("chains").select("*").eq("id", id).single());
  const items = (await q(sb.from("chain_items").select("position, task_id, tasks(*, task_comments(body, status, comment_type_id))").eq("chain_id", id).order("position")))
    .filter((it) => it.tasks);          // задачи-черновики автора коллегам не видны
  return { chain, items };
}

async function pageChain(id) {
  const { chain, items } = await loadChain(id);
  const mine = chain.teacher_id === S.user.id;
  if (!mine) return pageSharedChain(chain, items);
  const assigns = await q(sb.from("assignments").select("*").eq("chain_id", id).order("issued_on", { ascending: false }));
  shell("#/chains", `
    <p><a href="#/chains">← все цепочки</a></p>
    <h1>${esc(chain.title)} ${chain.shared ? '<span class="badge used">общая</span>' : ""}</h1>
    ${chain.shared && chain.description ? `<p class="muted">${esc(chain.description)}</p>` : ""}
    <div class="row">
      <a class="btn" href="#/print/${id}/student" target="_blank">Печать: для ученика</a>
      <a class="btn" href="#/print/${id}/teacher" target="_blank">Печать: для учителя</a>
      <button class="btn" data-act="sharechain" data-id="${id}" data-v="${!chain.shared}">${chain.shared ? "Сделать личной" : "Поделиться с коллегами"}</button>
      <button class="btn danger" data-act="delchain" data-id="${id}">Удалить цепочку</button>
    </div>
    ${chain.shared ? '<p class="small muted">Цепочку видят все учителя: название, описание и задачи. Кому и когда вы её выдавали – видите только вы.</p>' : ""}
    <ol class="chain">${items.map((it, i) => `
      <li><div class="meta"><a href="#/task/${it.task_id}">№${it.task_id}</a> ${stars(it.tasks.difficulty)} ${usageBadges(it.task_id)}</div>
        <div class="cond clamp">${esc(it.tasks.condition)}</div>
        <div class="row small">
          <button class="link" data-act="mv" data-id="${id}" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""}>↑ выше</button>
          <button class="link" data-act="mv" data-id="${id}" data-i="${i}" data-d="1" ${i === items.length - 1 ? "disabled" : ""}>↓ ниже</button>
          <button class="link" data-act="rmitem" data-id="${id}" data-i="${i}">убрать</button>
        </div></li>`).join("") || '<p class="muted">В цепочке нет задач. Добавляйте их со страницы задачи или через «Вариант».</p>'}</ol>
    <section class="panel">
      <h2>Выдать классу</h2>
      <form id="assign" class="row">
        <select name="class_id" required>${S.classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        <input type="date" name="issued_on" value="${new Date().toISOString().slice(0, 10)}">
        <button class="btn primary" ${S.classes.length ? "" : "disabled"}>Выдать</button>
      </form>
      ${assigns.map((a) => `<p class="small">Выдано ${esc(className(a.class_id))} – ${fmtDate(a.issued_on)} <button class="link" data-act="unassign" data-id="${a.id}" data-chain="${id}">отменить</button></p>`).join("")}
    </section>`);
  document.getElementById("assign").onsubmit = async (e) => {
    e.preventDefault(); const f = form(e.target);
    const repeats = items.filter((it) => (S.usage.get(it.task_id) || []).some((u) => u.class_id === +f.class_id));
    if (repeats.length && !confirm(`Задачи ${repeats.map((r) => "№" + r.task_id).join(", ")} уже давались этому классу. Всё равно выдать?`)) return;
    await q(sb.from("assignments").insert({ class_id: +f.class_id, chain_id: id, issued_on: f.issued_on }));
    await loadMine(); toast("Цепочка выдана"); pageChain(id);
  };
}

async function pageSharedChain(chain, items) {
  const info = (await q(sb.rpc("shared_chains"))).find((c) => c.id === chain.id) || {};
  shell("#/chains", `
    <p><a href="#/chains/shared">← общие цепочки</a></p>
    <h1>${esc(chain.title)}</h1>
    <p class="muted">Автор: ${esc(info.author)} · задач: ${items.length} · скопировали: ${info.copies ?? 0}</p>
    ${chain.description ? `<p>${esc(chain.description)}</p>` : ""}
    <div class="row">
      <button class="btn primary" data-act="copychain" data-id="${chain.id}">Скопировать себе</button>
      <a class="btn" href="#/print/${chain.id}/student" target="_blank">Печать: для ученика</a>
      <a class="btn" href="#/print/${chain.id}/teacher" target="_blank">Печать: для учителя</a>
    </div>
    <p class="small muted">Копию можно менять, дополнять и выдавать своим классам. Цепочка автора при этом не меняется.</p>
    <ol class="chain">${items.map((it) => `
      <li><div class="meta"><a href="#/task/${it.task_id}">№${it.task_id}</a> ${stars(it.tasks.difficulty)} ${usageBadges(it.task_id)}</div>
        <div class="cond clamp">${esc(it.tasks.condition)}</div></li>`).join("")}</ol>`);
}

async function reorderChain(id, order) {       // order – массив task_id в новом порядке
  await q(sb.from("chain_items").delete().eq("chain_id", id));
  if (order.length) await q(sb.from("chain_items").insert(order.map((task_id, i) => ({ chain_id: id, position: i + 1, task_id }))));
  pageChain(id);
}

async function pagePrint(id, mode) {
  const { chain, items } = await loadChain(id);
  const teacher = mode === "teacher";
  document.body.classList.add("print-mode");
  $app.innerHTML = `
    <div class="print">
      <div class="noprint row"><button class="btn primary" onclick="window.print()">Печать</button><a class="btn" href="#/chain/${id}" onclick="document.body.classList.remove('print-mode')">← назад</a></div>
      <h1>${esc(chain.title)}</h1>${teacher ? "<p><i>Экземпляр для учителя</i></p>" : "<p>Фамилия, имя: ______________________ Класс: _____ Дата: _________</p>"}
      ${items.map((it, i) => {
        const t = it.tasks;
        const comm = (t.task_comments || []).filter((c) => c.status === "published");
        return `<div class="ptask"><h3>Задача ${i + 1}${teacher ? ` <small>(№${t.id}, сложность ${t.difficulty})</small>` : ""}</h3>
          <div class="cond">${esc(t.condition)}</div>
          ${teacher ? `${t.solution ? `<p><b>Решение:</b></p><div class="cond">${esc(t.solution)}</div>` : ""}${t.answer ? `<p><b>Ответ:</b> ${esc(t.answer)}</p>` : ""}
            ${comm.map((c) => `<p class="small"><b>${esc(S.commentTypes.find((k) => k.id === c.comment_type_id)?.name)}:</b> ${esc(c.body)}</p>`).join("")}` : ""}
        </div>`;
      }).join("")}
    </div>`;
}
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#/print")) document.body.classList.remove("print-mode"); });

// ------------------------------------------------------------------ вариант
function pageVariant() {
  shell("#/variant", `
    <h1>Формирование варианта</h1>
    <form id="vf" class="stack narrow">
      <div class="row">
        <label>Раздел<select name="section" id="vsec">${sectionOptions("")}</select></label>
        <label>Тема<select name="topic" id="vtop">${topicOptions("", "")}</select></label>
      </div>
      <div class="row">
        <label>Класс<select name="grade"><option value="">любой</option>${[7, 8, 9, 10, 11].map((g) => `<option>${g}</option>`).join("")}</select></label>
        <label>Число задач<input type="number" name="n" value="5" min="1" max="30"></label>
        <label>Сложность от<select name="dmin">${[1, 2, 3, 4, 5].map((d) => `<option>${d}</option>`).join("")}</select></label>
        <label>до<select name="dmax">${[1, 2, 3, 4, 5].map((d) => `<option ${d === 5 ? "selected" : ""}>${d}</option>`).join("")}</select></label>
      </div>
      <label>Не брать задачи, которые уже давались классу
        <select name="exclude"><option value="">– не учитывать –</option>${S.classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" name="sort" checked> расположить по возрастанию сложности</label>
      <button class="btn primary">Подобрать</button>
    </form>
    <div id="vres"></div>`);
  const vsec = document.getElementById("vsec"), vtop = document.getElementById("vtop");
  vsec.onchange = () => (vtop.innerHTML = topicOptions(vsec.value, ""));
  document.getElementById("vf").onsubmit = async (e) => {
    e.preventDefault(); const f = form(e.target);
    let query = sb.from("tasks").select("id, grade, difficulty, condition, topic_id").eq("status", "published")
      .gte("difficulty", +f.dmin).lte("difficulty", +f.dmax);
    if (f.topic) query = query.eq("topic_id", +f.topic);
    else if (f.section) query = query.in("topic_id", S.topics.filter((t) => t.section_id === +f.section).map((t) => t.id));
    if (f.grade) query = query.eq("grade", +f.grade);
    let rows = await q(query);
    if (f.exclude) rows = rows.filter((r) => !(S.usage.get(r.id) || []).some((u) => u.class_id === +f.exclude));
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    rows = rows.slice(0, +f.n);
    if (f.sort) rows.sort((a, b) => a.difficulty - b.difficulty);
    S.variant = rows;
    document.getElementById("vres").innerHTML = rows.length ? `
      <p class="muted">Подобрано: ${rows.length} из запрошенных ${f.n}${rows.length < +f.n ? " – в банке не хватает подходящих задач (можно сгенерировать аналоги с помощью ИИ)" : ""}.</p>
      ${rows.map(taskCard).join("")}
      <form id="vsave" class="row"><input name="title" placeholder="Название цепочки" value="Вариант ${new Date().toLocaleDateString("ru-RU")}" required>
        <button class="btn primary">Сохранить как цепочку</button><button type="button" class="btn" data-act="reroll">Подобрать заново</button></form>` :
      `<p class="note">Подходящих задач не нашлось. Попробуйте расширить условия.</p>`;
    const vs = document.getElementById("vsave");
    if (vs) vs.onsubmit = async (ev) => {
      ev.preventDefault();
      const ch = await q(sb.from("chains").insert({ title: form(ev.target).title }).select().single());
      await q(sb.from("chain_items").insert(S.variant.map((t, i) => ({ chain_id: ch.id, position: i + 1, task_id: t.id }))));
      go("#/chain/" + ch.id);
    };
  };
}

// ------------------------------------------------------------------ черновики
async function pageDrafts() {
  const [tasks, comments] = await Promise.all([
    q(sb.from("tasks").select("*").eq("status", "draft").eq("author_id", S.user.id).order("created_at", { ascending: false })),
    q(sb.from("task_comments").select("*").eq("status", "draft").eq("author_id", S.user.id).order("created_at", { ascending: false })),
  ]);
  shell("#/drafts", `
    <h1>Черновики на проверку</h1>
    <p class="muted small">Здесь то, что предложил ИИ. Прочитайте, решите задачу сами, при необходимости исправьте – и только потом публикуйте в общий банк.</p>
    <h2>Задачи (${tasks.length})</h2>
    ${tasks.map((t) => `<div class="card static">
      <div class="meta"><span>№${t.id}</span><span>${t.grade} класс</span><span>${stars(t.difficulty)}</span>${t.parent_task_id ? `<span>аналог <a href="#/task/${t.parent_task_id}">№${t.parent_task_id}</a></span>` : ""}<span class="small">${esc(t.source)}</span></div>
      <div class="cond">${esc(t.condition)}</div>
      <details><summary>Решение и ответ</summary><div class="cond">${esc(t.solution)}</div><p><b>Ответ:</b> ${esc(t.answer)}</p></details>
      <div class="row"><a class="btn" href="#/edit/${t.id}">Исправить</a>
        <button class="btn primary" data-act="verify" data-id="${t.id}" data-origin="${t.origin}">Проверено – опубликовать</button>
        <button class="btn danger" data-act="deltask" data-id="${t.id}">Удалить</button></div></div>`).join("") || '<p class="muted">Нет черновиков задач.</p>'}
    <h2>Комментарии (${comments.length})</h2>
    ${comments.map((c) => `<div class="card static">
      <div class="meta"><span>к задаче <a href="#/task/${c.task_id}">№${c.task_id}</a></span><b>${esc(S.commentTypes.find((k) => k.id === c.comment_type_id)?.name)}</b></div>
      <textarea id="cb${c.id}" rows="3">${esc(c.body)}</textarea>
      <div class="row"><button class="btn primary" data-act="verifycomment" data-id="${c.id}">Проверено – опубликовать</button>
        <button class="btn danger" data-act="delcomment" data-id="${c.id}">Удалить</button></div></div>`).join("") || '<p class="muted">Нет черновиков комментариев.</p>'}`);
}

// ------------------------------------------------------------------ статистика ИИ (для исследования)
async function pageResearch() {
  const rows = await q(sb.from("ai_generations").select("id, teacher_id, task_id, kind, mode, with_context, model, teacher_rating, result_task_id, created_at, response, teacher_note").order("created_at", { ascending: false }));
  const published = new Set((await q(sb.from("tasks").select("id").eq("origin", "ai").eq("status", "published"))).map((t) => t.id));
  const groups = {};
  for (const r of rows) {
    const key = `${P.KINDS[r.kind]?.title ?? r.kind}|${r.with_context ? "с контекстом" : "без контекста"}`;
    const g = (groups[key] ||= { n: 0, answered: 0, rated: 0, sum: 0, saved: 0, pub: 0 });
    g.n++; if (r.response) g.answered++;
    if (r.teacher_rating) { g.rated++; g.sum += r.teacher_rating; }
    if (r.result_task_id) { g.saved++; if (published.has(r.result_task_id)) g.pub++; }
  }
  shell("#/research", `
    <h1>Работа с ИИ: статистика</h1>
    <p class="muted small">${isAdmin() ? "Вы администратор: здесь данные всех учителей." : "Здесь ваши запросы. Администратор видит сводку по всем учителям."} Эти данные можно использовать в статье: сравнить качество ответов ИИ с методическим контекстом из базы и без него.</p>
    <table class="tbl"><tr><th>Вид запроса</th><th>Контекст</th><th>Запросов</th><th>С ответом</th><th>Средняя оценка</th><th>Сохранено задач</th><th>Опубликовано после проверки</th></tr>
    ${Object.entries(groups).map(([k, g]) => { const [kind, ctx] = k.split("|"); return `<tr><td>${kind}</td><td>${ctx}</td><td>${g.n}</td><td>${g.answered}</td>
      <td>${g.rated ? (g.sum / g.rated).toFixed(2) + ` (оценок: ${g.rated})` : "–"}</td><td>${g.saved}</td><td>${g.pub}</td></tr>`; }).join("") || '<tr><td colspan="7" class="muted">Запросов пока не было</td></tr>'}
    </table>
    <button class="btn" data-act="csv">Скачать все запросы (CSV для Excel)</button>`);
  S.researchRows = rows;
}

function downloadCsv() {
  const rows = S.researchRows || [];
  const cols = ["id", "created_at", "teacher_id", "task_id", "kind", "mode", "with_context", "model", "teacher_rating", "teacher_note", "result_task_id", "response"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = "﻿" + [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `ai_generations_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ------------------------------------------------------------------ администратор: учителя и коды доступа
async function pageAdmin() {
  if (!isAdmin()) return go("#/tasks");
  const errType = S.commentTypes.find((c) => c.name === "Замечание об ошибке");
  const [teachers, codes, reports] = await Promise.all([
    q(sb.rpc("admin_teachers")),
    q(sb.from("access_codes").select("*").order("created_at", { ascending: false })),
    errType ? q(sb.from("task_comments").select("id, task_id, body, created_at, author:profiles!task_comments_author_id_fkey(full_name)").eq("comment_type_id", errType.id).order("created_at", { ascending: false }).limit(50)) : [],
  ]);
  const regLink = location.origin + location.pathname + "#/register";
  const active = teachers.filter((t) => t.approved && !t.blocked).length;
  shell("#/admin", `
    <h1>Учителя и доступ</h1>
    <section class="panel">
      <h2>Коды доступа</h2>
      <p class="small">Ссылка для регистрации (её же кодирует QR): <code>${esc(regLink)}</code>
        <button class="link" data-act="copylink" data-link="${esc(regLink)}">скопировать</button></p>
      <table class="tbl"><tr><th>Код</th><th>Для чего</th><th>Действует до</th><th>Использован</th><th>Статус</th><th></th></tr>
      ${codes.map((c) => `<tr class="${c.active ? "" : "muted"}"><td><code>${esc(c.code)}</code></td><td>${esc(c.label)}</td>
        <td>${c.valid_until ? fmtDate(c.valid_until) : "бессрочно"}</td><td>${c.uses}${c.max_uses ? " из " + c.max_uses : ""}</td>
        <td>${c.active ? "действует" : "выключен"}</td>
        <td><button class="link" data-act="togglecode" data-id="${c.id}" data-v="${!c.active}">${c.active ? "выключить" : "включить"}</button></td></tr>`).join("")
        || '<tr><td colspan="6" class="muted">Кодов нет</td></tr>'}</table>
      <form id="newCode" class="row">
        <label>Новый код<input name="code" required placeholder="например: октябрь2026"></label>
        <label>Для чего<input name="label" placeholder="Конференция"></label>
        <label>Дней действует<input name="days" type="number" min="1" value="30" style="width:6em"></label>
        <label>Макс. учителей<input name="max" type="number" min="1" value="200" style="width:6em"></label>
        <button class="btn primary">Создать</button>
      </form>
      <p class="small muted">Совет: после конференции выключите её код – новые люди не смогут зарегистрироваться, а уже вошедшие продолжат работать.</p>
    </section>
    <section class="panel"><h2>Замечания об ошибках (${reports.length})</h2>
      ${reports.map((r) => `<p><a href="#/task/${r.task_id}">Задача №${r.task_id}</a> – ${esc(r.body.slice(0, 160))} <span class="small muted">${esc(r.author?.full_name)} · ${fmtDate(r.created_at)}</span></p>`).join("") || '<p class="muted">Замечаний нет.</p>'}
    </section>
    <p class="panel">Разделы и темы – на отдельной странице <a href="#/topics">«Темы»</a>.</p>
    <section class="panel">
      <h2>Учителя (${teachers.length}, с доступом: ${active})</h2>
      <table class="tbl"><tr><th>ФИО</th><th>Почта</th><th>Школа</th><th>Код</th><th>Задач</th><th>Запросов к ИИ</th><th>Доступ</th><th></th></tr>
      ${teachers.map((t) => `<tr class="${t.blocked ? "muted" : ""}"><td>${esc(t.full_name)}${t.role === "admin" ? ' <span class="tag">админ</span>' : ""}</td>
        <td class="small">${esc(t.email)}</td><td class="small">${esc(t.school)}</td><td class="small">${esc(t.code_label)}</td>
        <td>${t.tasks_added}</td><td>${t.ai_requests}</td>
        <td>${t.blocked ? "заблокирован" : t.approved ? "есть" : "ждёт кода"}</td>
        <td class="small">${t.id === S.user.id ? "" : `
          ${!t.approved && !t.blocked ? `<button class="link" data-act="tapprove" data-uid="${t.id}">открыть доступ</button><br>` : ""}
          <button class="link" data-act="tblock" data-uid="${t.id}" data-v="${!t.blocked}">${t.blocked ? "разблокировать" : "заблокировать"}</button>`}</td></tr>`).join("")}
      </table>
    </section>`);
  document.getElementById("newCode").onsubmit = async (e) => {
    e.preventDefault(); const f = form(e.target);
    await q(sb.from("access_codes").insert({
      code: f.code.trim().toLowerCase(), label: f.label.trim() || null,
      valid_until: new Date(Date.now() + (+f.days || 30) * 864e5).toISOString(), max_uses: +f.max || null,
    }));
    toast("Код создан"); pageAdmin();
  };
}

// ------------------------------------------------------------------ разделы и темы (для всех учителей)
async function pageTopics() {
  await loadRefs();
  const [taskTopics, people] = await Promise.all([
    q(sb.from("tasks").select("topic_id")),
    q(sb.from("profiles").select("id, full_name")),
  ]);
  const cnt = {}; for (const r of taskTopics) cnt[r.topic_id] = (cnt[r.topic_id] || 0) + 1;
  const who = (id) => id ? (id === S.user.id ? "вы" : people.find((p) => p.id === id)?.full_name ?? "учитель") : "программа курса";
  const mine = (t) => isAdmin() || t.created_by === S.user.id;
  shell("#/topics", `
    <h1>Разделы и темы</h1>
    <p class="small muted">Темы общие для всех учителей. Добавить тему может любой учитель; переименовать или удалить – автор темы и администратор.
      Удалить можно только тему, в которой нет задач. Разделы меняет администратор.</p>
    ${S.sections.map((sec) => `<section class="panel"><h2>${esc(sec.name)} ${isAdmin() ? `<button class="link small" data-act="rensection" data-id="${sec.id}">переименовать</button>` : ""}</h2>
      <table class="tbl small">${S.topics.filter((t) => t.section_id === sec.id).map((t) => `<tr>
        <td>${esc(t.name)}</td><td>${t.grade ? t.grade + " кл." : "–"}</td><td class="muted">${esc(who(t.created_by))}</td><td>задач: ${cnt[t.id] || 0}</td>
        <td>${mine(t) ? `<button class="link" data-act="rentopic" data-id="${t.id}">переименовать</button>
          ${cnt[t.id] ? "" : ` · <button class="link" data-act="deltopic" data-id="${t.id}">удалить</button>`}` : ""}</td></tr>`).join("")}</table>
      <button class="link small" data-act="addtopic" data-section="${sec.id}">+ тема в этот раздел</button></section>`).join("")}
    ${isAdmin() ? `<form id="newSection" class="row"><input name="name" placeholder="Новый раздел" required><button class="btn">Добавить раздел</button></form>` : ""}`);
  const ns = document.getElementById("newSection");
  if (ns) ns.onsubmit = async (e) => {
    e.preventDefault();
    await q(sb.from("sections").insert({ name: form(e.target).name.trim(), sort_order: 100 + S.sections.length }));
    toast("Раздел добавлен"); pageTopics();
  };
}

// ------------------------------------------------------------------ общие действия (делегирование кликов)
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const a = b.dataset.act, id = +b.dataset.id;
  switch (a) {
    case "logout": await sb.auth.signOut(); break;
    case "forgot": {
      const email = prompt("Ваша почта – пришлём ссылку для смены пароля:");
      if (email) { await q(sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })); toast("Письмо отправлено, проверьте почту"); }
      break;
    }
    case "flag": {
      const row = { class_id: +b.dataset.class, task_id: S.ai.task.id, flag: b.dataset.flag };
      if (b.checked) await q(sb.from("class_task_flags").insert(row));
      else await q(sb.from("class_task_flags").delete().match(row));
      await loadMine(); break;
    }
    case "delcomment":
      if (confirm("Удалить комментарий?")) { await q(sb.from("task_comments").delete().eq("id", id)); route(); }
      break;
    case "deltask":
      if (confirm("Удалить задачу безвозвратно? Вместе с ней удалятся её комментарии.")) {
        const { error } = await sb.from("tasks").delete().eq("id", id);
        if (error) { toast(error.code === "23503" ? "Нельзя удалить: задача уже в цепочках у учителей. Исправьте её через «Редактировать»." : "Ошибка: " + error.message, true); break; }
        toast("Удалено"); await loadMine(); location.hash.startsWith("#/drafts") ? route() : go("#/tasks");
      }
      break;
    case "verify":
      if (b.dataset.origin === "ai") await q(sb.rpc("verify_ai_task", { p_task_id: id }));
      else await q(sb.from("tasks").update({ status: "published" }).eq("id", id));
      await q(sb.from("task_comments").update({ status: "published", verified_by: S.user.id }).eq("task_id", id).eq("status", "draft").eq("author_id", S.user.id));
      toast("Опубликовано в общем банке"); route(); break;
    case "verifycomment":
      await q(sb.from("task_comments").update({ body: document.getElementById("cb" + id).value.trim(), status: "published", verified_by: S.user.id }).eq("id", id));
      toast("Комментарий опубликован"); route(); break;
    case "archclass":
      await q(sb.from("classes").update({ archived: b.dataset.v === "true" }).eq("id", id)); await loadMine(); pageClasses(); break;
    case "sharechain": {
      const on = b.dataset.v === "true";
      let description = null;
      if (on) {
        description = prompt("Коротко опишите цепочку для коллег (класс, цель, как использовать). Можно оставить пустым:", "");
        if (description === null) break;
      }
      await q(sb.from("chains").update(on ? { shared: true, shared_at: new Date().toISOString(), description: description.trim() || null } : { shared: false }).eq("id", id));
      toast(on ? "Цепочка теперь видна всем учителям" : "Цепочка снова личная"); await loadMine(); pageChain(id); break;
    }
    case "copychain": {
      const { chain, items } = await loadChain(id);
      const c = await q(sb.from("chains").insert({ title: chain.title + " (копия)", copied_from: id }).select().single());
      if (items.length) await q(sb.from("chain_items").insert(items.map((it, i) => ({ chain_id: c.id, position: i + 1, task_id: it.task_id }))));
      await loadMine(); toast("Цепочка скопирована в «Мои»"); go("#/chain/" + c.id); break;
    }
    case "delchain":
      if (confirm("Удалить цепочку? Отметки о её выдаче тоже удалятся.")) { await q(sb.from("chains").delete().eq("id", id)); await loadMine(); go("#/chains"); }
      break;
    case "mv": case "rmitem": {
      const { items } = await loadChain(id);
      const order = items.map((x) => x.task_id), i = +b.dataset.i;
      if (a === "rmitem") order.splice(i, 1);
      else { const j = i + +b.dataset.d; [order[i], order[j]] = [order[j], order[i]]; }
      await reorderChain(id, order); break;
    }
    case "unassign":
      await q(sb.from("assignments").delete().eq("id", id)); await loadMine(); pageChain(+b.dataset.chain); break;
    case "reroll": document.getElementById("vf").requestSubmit(); break;
    case "ai-api": b.disabled = true; try { await aiApi(); } finally { b.disabled = false; } break;
    case "ai-copy": await aiCopy(); break;
    case "ai-paste": await aiPaste(); break;
    case "ai-save-task": await aiSaveTask(+b.dataset.i); b.disabled = true; b.textContent = "Сохранено ✓"; break;
    case "ai-save-comment": {
      const c = S.ai.parsed.comments[+b.dataset.i];
      await aiSaveComment(c.type, c.body); b.disabled = true; b.textContent = "Сохранено ✓"; break;
    }
    case "ai-solution-comment":
      await aiSaveComment("Методическая справка", "Решение (черновик ИИ):\n" + S.ai.parsed.solution + "\nОтвет: " + S.ai.parsed.answer);
      b.disabled = true; break;
    case "ai-apply-solution":
      await q(sb.from("tasks").update({ solution: S.ai.parsed.solution, answer: S.ai.parsed.answer }).eq("id", S.ai.task.id));
      toast("Решение записано в задачу"); pageTask(S.ai.task.id); break;
    case "ai-apply-fix":
      if (!confirm("Заменить решение и ответ задачи на исправленные? Вы проверили исправление?")) break;
      await q(sb.from("tasks").update({ solution: S.ai.parsed.fixed_solution, answer: S.ai.parsed.fixed_answer }).eq("id", S.ai.task.id));
      toast("Задача исправлена"); pageTask(S.ai.task.id); break;
    case "ai-rate": {
      const n = +b.dataset.n;
      await q(sb.from("ai_generations").update({ teacher_rating: n, teacher_note: document.getElementById("rateNote").value.trim() || null }).eq("id", S.ai.gen.id));
      document.querySelectorAll(".star").forEach((s) => s.classList.toggle("on", +s.dataset.n <= n));
      toast("Спасибо, оценка сохранена"); break;
    }
    case "csv": downloadCsv(); break;
    case "copylink":
      try { await navigator.clipboard.writeText(b.dataset.link); toast("Ссылка скопирована"); } catch { toast(b.dataset.link); }
      break;
    case "reporterr": {
      const f = document.getElementById("addComment");
      f.type.value = String(S.commentTypes.find((c) => c.name === "Замечание об ошибке").id);
      f.body.placeholder = "Опишите, что не так: в условии, решении или ответе. Автор задачи увидит замечание.";
      f.scrollIntoView({ behavior: "smooth", block: "center" }); f.body.focus(); break;
    }
    case "editcomment": {
      const box = document.getElementById("cm" + id), cond = box.querySelector(".cond");
      if (box.querySelector("textarea")) break;
      cond.outerHTML = `<div class="stack"><textarea rows="4">${esc(cond.textContent)}</textarea>
        <div class="row"><button class="btn primary" data-act="savecomment" data-id="${id}">Сохранить</button><button class="btn" data-act="cancelcomment">Отмена</button></div></div>`;
      break;
    }
    case "savecomment": {
      const body = dash(document.querySelector(`#cm${id} textarea`).value.trim());
      if (!body) { toast("Комментарий пустой", true); break; }
      await q(sb.from("task_comments").update({ body }).eq("id", id)); toast("Сохранено"); route(); break;
    }
    case "cancelcomment": route(); break;
    case "addtopic":
      if (await createTopic(b.dataset.section, null)) route();
      break;
    case "rentopic": case "rensection": {
      const isT = a === "rentopic", table = isT ? "topics" : "sections";
      const cur = isT ? topicById(id)?.name : sectionById(id)?.name;
      const name = (prompt("Новое название:", cur) || "").trim();
      if (name && name !== cur) {
        const { error } = await sb.from(table).update({ name }).eq("id", id);
        if (error) toast(/duplicate|unique/i.test(error.message) ? "Такое название уже есть в этом разделе" : "Ошибка: " + error.message, true);
        await loadRefs(); route();
      }
      break;
    }
    case "deltopic":
      if (confirm(`Удалить тему «${topicById(id)?.name}»?`)) {
        const { error } = await sb.from("topics").delete().eq("id", id);
        if (error) toast(error.code === "23503" ? "Нельзя удалить: в теме есть задачи (возможно, чьи-то черновики). Переименуйте тему или перенесите задачи." : "Ошибка: " + error.message, true);
        await loadRefs(); route();
      }
      break;
    case "togglecode":
      await q(sb.from("access_codes").update({ active: b.dataset.v === "true" }).eq("id", id)); pageAdmin(); break;
    case "tapprove":
      await q(sb.from("profiles").update({ approved: true }).eq("id", b.dataset.uid)); pageAdmin(); break;
    case "tblock":
      if (b.dataset.v === "true" && !confirm("Заблокировать учителя? Он сразу потеряет доступ к банку задач.")) break;
      await q(sb.from("profiles").update({ blocked: b.dataset.v === "true" }).eq("id", b.dataset.uid)); pageAdmin(); break;
  }
});

boot();
