// ============ 状态管理 ============
const state = {
  playerId: null,
  roomCode: null,
  role: null,
  word: null,
  currentPhase: 'welcome',
  isHost: false,
  describeTimer: null,
  voteTimer: null,
  guessTimer: null,
  selectedVoteTarget: null,
};

// ============ DOM 快捷引用 ============
const $ = id => document.getElementById(id);
const screens = {
  welcome: $('screen-welcome'),
  lobby: $('screen-lobby'),
  rules: $('screen-rules'),
  word: $('screen-word'),
  describe: $('screen-describe'),
  vote: $('screen-vote'),
  guess: $('screen-guess'),
  result: $('screen-result'),
  victory: $('screen-victory'),
};

// ============ Socket 连接 ============
const socket = io();

// ============ 屏幕切换 ============
function showScreen(name) {
  Object.keys(screens).forEach(k => screens[k].classList.remove('active'));
  if (screens[name]) screens[name].classList.add('active');
  state.currentPhase = name;
  window.scrollTo(0, 0);
}

// ============ Toast ============
function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

// ============ Tool ============
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function resetToWelcome() {
  Object.assign(state, { playerId: null, roomCode: null, role: null, word: null, currentPhase: 'welcome', isHost: false });
  $('nickname-input').value = '';
  $('room-code-input').value = '';
  document.querySelectorAll('.confetti-container, .particle').forEach(el => el.remove());
  document.title = '谁是卧底';
  showScreen('welcome');
}

function updateTitle(suffix) {
  document.title = suffix ? `谁是卧底 - ${suffix}` : '谁是卧底';
}

// ============ 玩家状态条 ============
function renderDescStatusBar(players, describedIds, currentSpeakerId) {
  const bar = $('desc-status-bar');
  bar.innerHTML = players.filter(p => p.isAlive).map(p => {
    const isDone = describedIds.includes(p.id);
    const isCurrent = p.id === currentSpeakerId;
    let cls = 'status-dot';
    let dotCls = 'gray';
    let label = escapeHtml(p.name);
    if (isCurrent) { cls += ' waiting'; dotCls = 'yellow'; label += ' 🎤'; }
    else if (isDone) { cls += ' done'; dotCls = 'green'; label += ' ✓'; }
    return `<span class="${cls}"><span class="dot ${dotCls}"></span>${label}</span>`;
  }).join('');
}

function renderVoteStatusBar(players, votedIds) {
  const bar = $('vote-status-bar');
  bar.innerHTML = players.filter(p => p.isAlive).map(p => {
    const hasVoted = votedIds.includes(p.id);
    const isMe = p.id === state.playerId;
    const cls = `status-dot ${hasVoted ? 'voted' : ''}`;
    const dotCls = hasVoted ? 'blue' : 'gray';
    const label = hasVoted ? `${escapeHtml(p.name)} ✓` : (isMe ? `${escapeHtml(p.name)}（你）` : escapeHtml(p.name));
    return `<span class="${cls}"><span class="dot ${dotCls}"></span>${label}</span>`;
  }).join('');
}

// =====================================================
//  首页
// =====================================================
$('btn-create-room').addEventListener('click', () => {
  const name = $('nickname-input').value.trim();
  if (!name) return showToast('请输入昵称', 'error');
  socket.emit('create_room', { nickname: name });
});
$('btn-join-room').addEventListener('click', () => {
  const name = $('nickname-input').value.trim();
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!name) return showToast('请输入昵称', 'error');
  if (code.length !== 6) return showToast('房间号为6位字符', 'error');
  socket.emit('join_room', { nickname: name, roomCode: code });
});
$('nickname-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-room').click(); });
$('room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join-room').click(); });

// =====================================================
//  大厅
// =====================================================
function renderLobby(room) {
  $('lobby-room-code').textContent = room.code;
  renderPlayers(room.players);
  $('lobby-player-count').textContent = room.players.length;
  updateStartBtn(room.players.length);
}
function renderPlayers(players) {
  $('lobby-player-list').innerHTML = players.map(p =>
    `<div class="player-card">
      <div class="name">${escapeHtml(p.name)}</div>
      ${p.isHost ? '<div class="badge-host">房主</div>' : ''}
      ${!p.isConnected ? '<div class="badge-disconnected">已断线</div>' : ''}
    </div>`
  ).join('');
}
function updateStartBtn(count) {
  const btn = $('btn-start-game');
  const hint = $('lobby-hint');
  btn.disabled = false;
  hint.textContent = count <= 1 ? '单人测试模式' : `${count} 人准备就绪`;
}

$('btn-start-game').addEventListener('click', () => {
  if (!state.isHost) return showToast('只有房主可以开始游戏', 'error');
  socket.emit('start_game', { settings: gatherSettings() });
});
$('btn-leave').addEventListener('click', () => { socket.emit('leave_room'); resetToWelcome(); });
$('btn-copy-room').addEventListener('click', () => {
  const code = $('lobby-room-code').textContent;
  if (!code || code === '------') return;
  navigator.clipboard.writeText(code).then(() => showToast('房间号已复制 📋')).catch(() => showToast('复制失败，请手动记下房间号', 'error'));
});

// =====================================================
//  设置
// =====================================================
$('btn-settings').addEventListener('click', () => { if (!state.isHost) return showToast('只有房主可以修改设置', 'error'); $('settings-modal').classList.add('active'); });
$('btn-settings-close').addEventListener('click', () => { $('settings-modal').classList.remove('active'); if (state.isHost) socket.emit('update_settings', { settings: gatherSettings() }); });
$('settings-modal').addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) $('settings-modal').classList.remove('active'); });

document.querySelectorAll('.btn-setting').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.setting;
    const dir = btn.dataset.action;
    const span = $(`setting-${key}`);
    const val = parseInt(span.textContent);
    const ranges = { spyCount: [1, 2], describeTime: [15, 20, 30, 60], voteTime: [30, 60, 90], roundLimit: [1, 2, 3, 5, 10] };
    const range = ranges[key] || [1, 5];
    const idx = range.indexOf(val);
    const nv = dir === 'inc' ? (idx < range.length - 1 ? range[idx + 1] : val) : (idx > 0 ? range[idx - 1] : val);
    if (nv !== val) span.textContent = nv;
  });
});

function gatherSettings() {
  return {
    spyCount: +$('setting-spyCount').textContent,
    whiteMode: $('setting-whiteMode').checked,
    guessEnabled: $('setting-guessEnabled').checked,
    describeTime: +$('setting-describeTime').textContent,
    voteTime: +$('setting-voteTime').textContent,
    roundLimit: +$('setting-roundLimit').textContent,
  };
}

// =====================================================
//  看词
// =====================================================
// 翻牌动画
$('word-card-wrapper').addEventListener('click', () => {
  const card = $('word-card');
  if (!card.classList.contains('flipped')) {
    card.classList.add('flipped');
    $('btn-confirm-word').style.display = 'inline-flex';
  }
});

$('btn-confirm-word').addEventListener('click', () => {
  $('btn-confirm-word').disabled = true;
  $('btn-confirm-word').textContent = '已确认 ✓';
  socket.emit('confirm_word');
});

// =====================================================
//  描述
// =====================================================
$('btn-submit-describe').addEventListener('click', () => {
  const c = $('describe-input').value.trim();
  if (!c) return showToast('请输入描述', 'error');
  socket.emit('submit_description', { content: c });
});
$('describe-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('btn-submit-describe').click(); }
});

function addDescItem(name, content, isOwn) {
  const list = $('descriptions-list');
  const ph = list.querySelector('.desc-placeholder');
  if (ph) ph.remove();
  const item = document.createElement('div');
  item.className = `desc-item ${isOwn ? 'own' : ''}`;
  item.innerHTML = `<div class="desc-name">${escapeHtml(name)}</div><div class="desc-content">${escapeHtml(content)}</div>`;
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

function startDescribeTimer(sec) {
  if (state.describeTimer) clearInterval(state.describeTimer);
  const fill = $('describe-timer-fill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  setTimeout(() => { fill.style.transition = `width ${sec}s linear`; fill.style.width = '0%'; }, 50);
  state.describeTimer = setInterval(() => { sec--; if (sec <= 0) clearInterval(state.describeTimer); }, 1000);
}

// =====================================================
//  投票
// =====================================================
function startVoteTimer(sec) {
  if (state.voteTimer) clearInterval(state.voteTimer);
  const el = $('vote-timer-text');
  el.textContent = sec;
  el.classList.remove('urgent');
  state.voteTimer = setInterval(() => {
    sec--;
    el.textContent = sec;
    if (sec <= 10) el.classList.add('urgent');
    if (sec <= 0) clearInterval(state.voteTimer);
  }, 1000);
}

function renderVotePlayers(players) {
  const list = $('vote-player-list');
  list.innerHTML = '';
  state.selectedVoteTarget = null;

  // 移除旧的投票确认按钮
  const oldBtn = document.getElementById('btn-confirm-vote-wrapper');
  if (oldBtn) oldBtn.remove();

  players.forEach(p => {
    if (!p.isAlive) return;
    const card = document.createElement('div');
    card.className = 'player-card';
    if (p.id === state.playerId) {
      card.classList.add('self');
      card.innerHTML = `<div class="name">${escapeHtml(p.name)}</div><div style="font-size:12px;color:rgba(255,255,255,0.3)">（你自己）</div>`;
      card.addEventListener('click', () => showToast('不能投给自己', 'error'));
    } else {
      card.innerHTML = `<div class="name">${escapeHtml(p.name)}</div>`;
      card.addEventListener('click', () => {
        state.selectedVoteTarget = p.id;
        list.querySelectorAll('.player-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        const cv = document.getElementById('btn-confirm-vote');
        if (cv) cv.disabled = false;
      });
    }
    list.appendChild(card);
  });

  const wrapper = document.createElement('div');
  wrapper.id = 'btn-confirm-vote-wrapper';
  wrapper.style.cssText = 'margin-top:auto;text-align:center;padding-top:16px';
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-large';
  btn.id = 'btn-confirm-vote';
  btn.textContent = '投票';
  btn.disabled = true;
  btn.addEventListener('click', () => {
    if (!state.selectedVoteTarget) return;
    socket.emit('submit_vote', { targetId: state.selectedVoteTarget });
    showToast('投票已提交');
    btn.disabled = true;
    btn.textContent = '已投票 ✓';
  });
  wrapper.appendChild(btn);
  list.parentElement.appendChild(wrapper);
}

function selectVoteTarget(id, card) {
  state.selectedVoteTarget = id;
  document.querySelectorAll('#vote-player-list .player-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
  const btn = document.getElementById('btn-confirm-vote');
  if (btn) btn.disabled = false;
}

// =====================================================
//  猜词
// =====================================================
$('btn-submit-guess').addEventListener('click', () => {
  const w = $('guess-input').value.trim();
  if (!w) return showToast('请输入你猜测的平民词', 'error');
  socket.emit('submit_guess', { guessedWord: w });
  $('btn-submit-guess').disabled = true;
  $('btn-submit-guess').textContent = '已猜 ✓';
});
$('guess-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-submit-guess').click(); });
$('btn-skip-guess').addEventListener('click', () => socket.emit('skip_guess'));

function startRulesTimer(sec) {
  const fill = $('rules-timer-fill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  setTimeout(() => {
    fill.style.transition = `width ${sec}s linear`;
    fill.style.width = '0%';
  }, 100);
  $('rules-tip').textContent = `游戏将在 ${sec} 秒后开始...`;
  let n = sec;
  const t = setInterval(() => { n--; if (n > 0) $('rules-tip').textContent = `游戏将在 ${n} 秒后开始...`; else clearInterval(t); }, 1000);
}

function startGuessTimer(sec) {
  if (state.guessTimer) clearInterval(state.guessTimer);
  const fill = $('guess-timer-fill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  setTimeout(() => { fill.style.transition = `width ${sec}s linear`; fill.style.width = '0%'; }, 50);
  state.guessTimer = setInterval(() => { sec--; if (sec <= 0) clearInterval(state.guessTimer); }, 1000);
}

// =====================================================
//  投票结果
// =====================================================
function showVoteResult(data) {
  showScreen('result');
  updateTitle(`${state.roomCode} | 结果`);
  const reveal = $('result-reveal');
  reveal.innerHTML = '';
  $('btn-continue').style.display = 'none';

  if (data.votes && data.votes.length) {
    const h = document.createElement('h3');
    h.textContent = '📊 投票详情';
    h.style.marginBottom = '12px';
    reveal.appendChild(h);
    data.votes.forEach((v, i) => {
      const d = document.createElement('div');
      d.className = 'result-item';
      d.style.animationDelay = `${i * 0.15}s`;
      d.innerHTML = `<div class="result-player">${escapeHtml(v.voterName)} → ${escapeHtml(v.targetName)}</div>`;
      reveal.appendChild(d);
    });
  }

  const baseDelay = (data.votes?.length || 0);

  if (data.tally) {
    setTimeout(() => {
      data.tally.forEach((t, i) => {
        const d = document.createElement('div');
        d.className = 'result-item';
        d.style.animationDelay = `${(baseDelay + i) * 0.15}s`;
        d.innerHTML = `<div class="result-player">${escapeHtml(t.playerName)}</div><div class="result-detail">${t.count} 票</div>`;
        if (data.eliminated && t.playerId === data.eliminated.id) d.classList.add('eliminated');
        reveal.appendChild(d);
      });
    }, baseDelay * 150 + 500);
  }

  setTimeout(() => {
    if (data.eliminated) {
      const info = document.createElement('div');
      info.className = 'result-item eliminated';
      info.style.animationDelay = `${(baseDelay + (data.tally?.length || 0)) * 0.15 + 0.3}s`;
      info.innerHTML = `<div class="result-player">🚫 ${escapeHtml(data.eliminated.name)} 被投出局！</div>`;
      reveal.appendChild(info);
    } else {
      const info = document.createElement('div');
      info.className = 'result-tie';
      info.textContent = '⚖️ 平票，本轮无人出局';
      reveal.appendChild(info);
    }
    $('btn-continue').style.display = 'block';
  }, (baseDelay + (data.tally?.length || 0)) * 150 + 1000);
}

$('btn-continue').addEventListener('click', () => {
  $('btn-continue').style.display = 'none';
  showToast('等待下一阶段...');
});

// =====================================================
//  结算
// =====================================================
function showVictory(data) {
  showScreen('victory');
  const bg = $('victory-bg');
  const txt = $('victory-text');
  const icon = $('victory-icon');
  const sub = $('victory-subtitle');

  bg.className = 'victory-bg';
  txt.className = 'victory-text';
  $('victory-container').querySelectorAll('.confetti-container, .particle').forEach(el => el.remove());

  let bgCls = '', txtCls = '';
  if (data.isSpecialWin) {
    bgCls = 'special-bg'; txtCls = 'special-text';
    icon.textContent = '👑'; sub.textContent = '完美表现！';
  } else if (data.winner === 'civilian') {
    bgCls = 'civilian-bg'; txtCls = 'civilian-text';
    icon.textContent = '🎉'; sub.textContent = '平民成功找出卧底！';
  } else if (data.winner === 'spy') {
    bgCls = 'spy-bg'; txtCls = 'spy-text';
    icon.textContent = '🕵️'; sub.textContent = '卧底完美潜伏到最后！';
  } else if (data.winner === 'white') {
    bgCls = 'white-bg'; txtCls = 'white-text';
    icon.textContent = '🎭'; sub.textContent = '白板成功骗过所有人！';
  }
  bg.classList.add(bgCls);
  txt.className = `victory-text ${txtCls}`;
  txt.textContent = data.winnerText || '游戏结束';

  if (data.wordPair) {
    $('victory-civilian-word').textContent = data.wordPair.civilian || '---';
    $('victory-spy-word').textContent = data.wordPair.spy || '---';
  }

  // 角色揭晓
  const grid = $('role-reveal-grid');
  grid.innerHTML = '';
  (data.roleReveal || []).forEach(p => {
    const names = { civilian: '👤 平民', spy: '🕵️ 卧底', white: '⬜ 白板' };
    grid.innerHTML +=
      `<div class="role-reveal-item ${p.isAlive ? '' : 'dead'}">
        <div class="rr-name">${escapeHtml(p.name)}</div>
        <div class="rr-role ${p.role}">${names[p.role] || p.role}</div>
        ${!p.isAlive ? '<div style="font-size:11px;color:rgba(255,255,255,0.3)">已出局</div>' : ''}
      </div>`;
  });

  // 猜词结果
  const existing = grid.nextElementSibling;
  if (existing && existing.tagName === 'P' && existing.style.color) existing.remove();
  if (data.guessResult) {
    const gi = document.createElement('p');
    gi.style.cssText = 'margin:12px 0;font-size:14px;color:rgba(255,255,255,0.6)';
    gi.textContent = data.guessResult.isCorrect
      ? `🎯 ${data.guessResult.playerName} 猜中了平民词「${data.guessResult.guessedWord}」！`
      : `❌ ${data.guessResult.playerName} 猜错了（猜: ${data.guessResult.guessedWord}）`;
    grid.after(gi);
  }

  // 判断败者显示嘲讽
  const taunt = $('victory-taunt');
  const isLoser = (
    (data.winner === 'civilian' && state.role !== 'civilian') ||
    (data.winner === 'spy' && state.role !== 'spy') ||
    (data.winner === 'white' && state.role !== 'white') ||
    (data.winner === 'spy_or_white' && state.role === 'civilian')
  );
  taunt.style.display = isLoser ? 'block' : 'none';

  launchEffects(data.winner, data.isSpecialWin);
}

function launchEffects(winner, isSpecial) {
  const bg = $('victory-bg');
  const colors = isSpecial ? ['#ffd700', '#ff6bc1', '#ff4500', '#7b68ee', '#00ff88']
    : winner === 'civilian' ? ['#ffd700', '#ffec8b', '#fff8dc']
    : winner === 'spy' ? ['#9370db', '#8a2be2', '#da70d6']
    : ['#00ced1', '#48d1cc', '#7fffd4'];
  const n = isSpecial ? 80 : 40;

  const cc = document.createElement('div');
  cc.className = 'confetti-container';
  bg.appendChild(cc);
  for (let i = 0; i < n; i++) {
    const e = document.createElement('div');
    e.className = 'confetti';
    e.style.cssText = `left:${Math.random()*100}%;background:${colors[i%colors.length]};width:${4+Math.random()*8}px;height:${4+Math.random()*8}px;border-radius:${Math.random()>0.5?'50%':'2px'};animation-duration:${2+Math.random()*3}s;animation-delay:${Math.random()*2}s`;
    cc.appendChild(e);
  }
  for (let i = 0; i < (isSpecial ? 40 : 20); i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const s = 3 + Math.random() * 6;
    p.style.cssText = `width:${s}px;height:${s}px;background:${colors[i%colors.length]};left:${30+Math.random()*40}%;top:${40+Math.random()*20}%;--tx:${(Math.random()-0.5)*300}px;--ty:${-200-Math.random()*200}px;animation-duration:${1+Math.random()}s;animation-delay:${Math.random()*0.5}s`;
    bg.appendChild(p);
  }
}

// =====================================================
//  再来一局
// =====================================================
$('btn-play-again').addEventListener('click', () => {
  if (state.isHost) socket.emit('new_game');
  else showToast('等待房主开始新游戏...');
});
$('btn-back-lobby').addEventListener('click', () => {
  if (state.isHost) socket.emit('new_game');
  else showToast('等待房主操作...');
});

// =====================================================
//  Socket 事件监听
// =====================================================
socket.on('connect', () => console.log('[连接] 已连接到服务器'));
socket.on('disconnect', () => { showToast('与服务器断开连接', 'error'); });

// -- 房间事件 --
socket.on('room_created', d => {
  Object.assign(state, { playerId: d.playerId, roomCode: d.roomCode, isHost: true });
  showScreen('lobby');
  renderLobby(d.room);
  updateTitle(`${d.roomCode} | 大厅`);
});
socket.on('room_joined', d => {
  Object.assign(state, { playerId: d.playerId, roomCode: d.room.code, isHost: d.room.hostId === d.playerId });
  showScreen('lobby');
  renderLobby(d.room);
  updateTitle(`${d.room.code} | 大厅`);
});
socket.on('player_joined', d => {
  renderPlayers(d.players);
  $('lobby-player-count').textContent = d.players.length;
  updateStartBtn(d.players.length);
});
socket.on('player_left', d => {
  renderPlayers(d.players);
  $('lobby-player-count').textContent = d.players.length;
  updateStartBtn(d.players.length);
});
socket.on('player_disconnected', d => showToast(`${d.name} 断线了`, 'error'));
socket.on('kicked', () => { showToast('你被房主移出了房间', 'error'); resetToWelcome(); });

// -- 游戏阶段 --
socket.on('phase_changed', d => {
  state.currentPhase = d.phase;
  switch (d.phase) {
    case 'starting':
      showToast('游戏即将开始...');
      updateTitle(`${state.roomCode} | 准备中`);
      break;
    case 'rules':
      showScreen('rules');
      startRulesTimer(d.duration || 6);
      updateTitle(`${state.roomCode} | 规则`);
      break;
    case 'dealing':
      showScreen('word');
      $('word-round').textContent = d.round || 1;
      $('confirm-count').textContent = '0';
      $('confirm-total').textContent = '?';
      // 重置翻牌
      $('word-card').classList.remove('flipped');
      $('btn-confirm-word').style.display = 'none';
      $('btn-confirm-word').disabled = false;
      $('btn-confirm-word').textContent = '我已记住，确认';
      updateTitle(`${state.roomCode} | 看词`);
      break;
    case 'describing':
      showScreen('describe');
      $('desc-round').textContent = d.round || 1;
      $('descriptions-list').innerHTML = '<div class="desc-placeholder">等待描述开始...</div>';
      break;
    case 'voting':
      showScreen('vote');
      startVoteTimer(d.timeLimit || 60);
      $('vote-count').textContent = '0';
      $('vote-total').textContent = '?';
      if (d.players) renderVotePlayers(d.players);
      break;
  }
});

// -- 投票玩家列表 --
// -- 角色分配 --
socket.on('your_role', d => {
  state.role = d.role;
  state.word = d.word;
  const badge = $('word-role-badge');
  const hint = $('word-hint');
  $('word-text').textContent = d.word || '（无）';
  if (d.role === 'civilian') {
    badge.textContent = '👤 平民'; badge.className = 'role-badge civilian';
    hint.textContent = '请用巧妙的方式描述，别让卧底发现';
  } else if (d.role === 'spy') {
    badge.textContent = '🕵️ 卧底'; badge.className = 'role-badge spy';
    hint.textContent = '隐藏自己，找到机会猜出平民词！';
  } else {
    badge.textContent = '⬜ 白板'; badge.className = 'role-badge white';
    hint.textContent = '你没有词语！靠演技混过去！';
  }
});

socket.on('confirm_progress', d => {
  $('confirm-count').textContent = d.confirmed;
  $('confirm-total').textContent = d.total;
});

// -- 描述 --
socket.on('describe_turn', d => {
  const isMe = d.speakerId === state.playerId;
  $('describe-input-area').style.display = isMe ? 'block' : 'none';
  $('desc-waiting-msg').style.display = isMe ? 'none' : 'flex';
  if (isMe) {
    $('desc-turn-indicator').textContent = '轮到你了！';
    $('describe-input').value = '';
    $('describe-input').focus();
    startDescribeTimer(d.timeLimit);
  } else {
    $('desc-waiting-text').textContent = `等待 ${escapeHtml(d.speakerName)} 描述...`;
    $('desc-turn-indicator').textContent = `${escapeHtml(d.speakerName)} 描述中...`;
  }
  // 更新玩家描述状态条
  if (d.alivePlayers) {
    renderDescStatusBar(d.alivePlayers, d.describedIds || [], d.speakerId);
  }
  updateTitle(`${state.roomCode} | 描述中`);
});
socket.on('description_received', d => addDescItem(d.playerName, d.description, d.playerId === state.playerId));
socket.on('all_descriptions', d => {
  $('descriptions-list').innerHTML = '';
  d.descriptions.forEach(x => addDescItem(x.playerName, x.description, x.playerId === state.playerId));
  $('desc-turn-indicator').textContent = '所有人描述完毕！';
  $('describe-input-area').style.display = 'none';
  $('desc-waiting-msg').style.display = 'none';
});

// -- 投票 --
socket.on('vote_progress', d => {
  $('vote-count').textContent = d.votedCount;
  $('vote-total').textContent = d.totalCount;
});
let _votePlayers = [];
socket.on('vote_players', d => {
  _votePlayers = d.players;
  renderVotePlayers(d.players);
  renderVoteStatusBar(d.players, []);
  updateTitle(`${state.roomCode} | 投票中`);
});
socket.on('vote_status', d => {
  if (_votePlayers.length) {
    renderVoteStatusBar(_votePlayers, d.votedPlayerIds || []);
  }
});
socket.on('vote_result', d => {
  clearInterval(state.voteTimer);
  showVoteResult(d);
});

// -- 猜词 --
socket.on('guess_phase', d => {
  showScreen('guess');
  $('guess-round').textContent = d.round || 1;
  updateTitle(`${state.roomCode} | 猜词`);
  if (d.canGuess) {
    $('guess-input-area').style.display = 'block';
    $('guess-waiting').style.display = 'none';
    $('guess-input').value = '';
    $('guess-input').focus();
    $('btn-submit-guess').disabled = false;
    $('btn-submit-guess').textContent = '猜';
    startGuessTimer(d.timeLimit);
  } else {
    $('guess-input-area').style.display = 'none';
    $('guess-waiting').style.display = 'flex';
    const names = d.guessingPlayerNames || [];
    $('guess-waiting-text').textContent = names.length ? `${names.join('、')} 正在思考...` : '等待猜词阶段结束...';
  }
});
socket.on('guess_result', d => {
  showToast(d.correct ? '🎯 猜对了！即将揭晓！' : '❌ 猜错了，游戏继续');
});
socket.on('guess_made', d => showToast(`${d.playerName} 提交了猜测`));
socket.on('guess_skipped', () => {
  showToast('你放弃了猜词');
  $('guess-input-area').style.display = 'none';
  $('guess-waiting').style.display = 'flex';
  $('guess-waiting-text').textContent = '等待其他人...';
});

// -- 结束 --
socket.on('game_ended', d => {
  showVictory(d);
  updateTitle(`${state.roomCode} | 游戏结束`);
});

socket.on('return_to_lobby', d => {
  state.isHost = d.room.hostId === state.playerId;
  showScreen('lobby');
  renderLobby(d.room);
  updateTitle(`${state.roomCode} | 大厅`);
});

// -- 错误 --
socket.on('error', d => showToast(d.msg || '操作失败', 'error'));

// =====================================================
//  初始化
// =====================================================
window.addEventListener('beforeunload', () => { if (state.roomCode) socket.emit('leave_room'); });
console.log('🎭 谁是卧底 - 客户端已加载');
