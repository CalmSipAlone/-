// ============ 状态 ============
const state = {
  playerId: null, roomCode: null, role: null, word: null,
  currentPhase: 'welcome', isHost: false,
  describedIds: [], votedIds: [], selectedVote: null,
  hasFlippedCard: false,
};

// ============ DOM ============
const $ = id => document.getElementById(id);

// ============ Socket ============
const socket = io();

// ============ 工具 ============
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function updateTitle(s) { document.title = s ? `谁是卧底 - ${s}` : '谁是卧底'; }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(`screen-${name}`);
  if (el) el.classList.add('active');
  state.currentPhase = name;
  window.scrollTo(0, 0);
}

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
}

function resetToWelcome() {
  Object.assign(state, { playerId: null, roomCode: null, role: null, word: null, currentPhase: 'welcome', isHost: false, hasFlippedCard: false });
  document.querySelectorAll('.confetti-container, .particle').forEach(e => e.remove());
  document.title = '谁是卧底';
  showScreen('welcome');
}

// ============ 环形玩家布局 ============
function renderPlayerRing(container, players, opts = {}) {
  const { currentSpeakerId, describedIds, votedIds } = opts;
  const alive = players.filter(p => p.isAlive);
  const ringEl = document.getElementById(container) || container;
  if (!ringEl) return;
  ringEl.innerHTML = '';

  if (alive.length === 0) return;

  const isMe = id => id === state.playerId;
  const myIdx = alive.findIndex(p => isMe(p.id));
  const idx = myIdx >= 0 ? myIdx : 0;
  const count = alive.length;
  const r = Math.min(ringEl.offsetWidth, ringEl.offsetHeight) * 0.35;

  alive.forEach((p, i) => {
    const angle = -Math.PI / 2 + ((i - idx) / count) * 2 * Math.PI;
    const cx = 50 + (r / ringEl.offsetWidth) * 100 * Math.cos(angle);
    const cy = 50 + (r / ringEl.offsetHeight) * 100 * Math.sin(angle);
    const isSpeaking = p.id === currentSpeakerId;
    const isDead = !p.isAlive;
    const amMe = isMe(p.id);

    const piece = document.createElement('div');
    piece.className = `player-piece ${isDead ? 'dead' : 'alive'} ${isSpeaking ? 'speaking' : ''} ${amMe ? 'me' : ''}`;
    piece.style.left = `${cx}%`; piece.style.top = `${cy}%`;
    piece.style.transform = 'translate(-50%, -50%)';
    const initial = p.name.charAt(0);
    piece.innerHTML = `
      <div class="avatar">${initial}</div>
      <div class="p-name">${escapeHtml(p.name)}${amMe ? '（你）' : ''}</div>
    `;
    ringEl.appendChild(piece);
  });
}

// ============ 桌面中央信息 ============
function setCenterInfo(phase, round, spyAlive, timer) {
  const phaseEl = $('center-phase');
  const spyEl = $('center-spy');
  const timerEl = $('center-timer');
  if (phaseEl) {
    const labels = { describing: '🎤 描述中', voting: '🗳️ 投票中', guessing: '🤔 猜词中', dealing: '🃏 看词中', result: '📊 结算' };
    phaseEl.textContent = `${labels[phase] || phase} 第${round}轮`;
  }
  if (spyEl) spyEl.textContent = spyAlive !== undefined ? `🕵️ 卧底 ×${spyAlive}` : '🕵️ 卧底 ?';
  if (timerEl) {
    if (timer !== undefined && timer !== null) {
      timerEl.textContent = `${timer}s`;
      timerEl.style.display = 'block';
    } else {
      timerEl.style.display = 'none';
    }
  }
}

// ============ 身份词卡 ============
function setupWordCard() {
  const card = $('word-card-toggle');
  if (!card) return;
  card.addEventListener('click', () => {
    card.classList.toggle('hidden');
    if (!state.hasFlippedCard) {
      state.hasFlippedCard = true;
      $('btn-confirm-word').style.display = 'flex';
    }
  });
}

function setWordCard(role, word) {
  state.role = role;
  state.word = word;
  state.hasFlippedCard = false;
  const card = $('word-card-toggle');
  if (!card) return;
  card.classList.remove('hidden');
  const labels = { civilian: '👤 平民', spy: '🕵️ 卧底', white: '⬜ 白板' };
  $('word-card-role').textContent = labels[role] || role;
  $('word-card-text').textContent = word || '（无）';
  $('btn-confirm-word').style.display = 'none';
}

// ============ 侧栏 ============
$('side-panel-toggle')?.addEventListener('click', () => {
  $('side-panel').classList.toggle('collapsed');
});

let _describedList = [];

function addSideDescription(name, content) {
  const list = $('side-descriptions');
  if (!list) return;
  const empty = list.querySelector('.side-empty');
  if (empty) empty.remove();
  const item = document.createElement('div');
  item.className = 'side-desc-item';
  item.innerHTML = `<div class="side-desc-name">${escapeHtml(name)}</div><div class="side-desc-text">${escapeHtml(content)}</div>`;
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
  _describedList.push(name);
}

function clearSideDescriptions() {
  const list = $('side-descriptions');
  if (list) list.innerHTML = '<div class="side-empty">等待发言...</div>';
  _describedList = [];
}

function updateVoteDots(players, votedIds) {
  const dots = $('side-vote-dots');
  if (!dots) return;
  dots.innerHTML = '';
  (players || []).filter(p => p.isAlive).forEach(p => {
    const dot = document.createElement('div');
    dot.className = `side-vote-dot ${votedIds.includes(p.id) ? 'voted' : ''}`;
    dot.title = p.name;
    dots.appendChild(dot);
  });
}

// ============ 底部操作栏 ============
function showBottomButtons(buttons) {
  ['btn-describe', 'btn-vote', 'btn-skip', 'btn-log', 'btn-guess', 'btn-confirm'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });
  buttons.forEach(id => { const el = $(id); if (el) el.style.display = 'flex'; });
}

// ============ 游戏阶段切换 ============
function enterGamePhase(phase, data) {
  showScreen('game');
  setCenterInfo(phase, data?.round || 1, data?.spyAlive);

  switch (phase) {
    case 'dealing':
      showBottomButtons(['btn-confirm']);
      clearSideDescriptions();
      break;
    case 'describing':
      showBottomButtons(['btn-log']);
      break;
    case 'voting':
      showBottomButtons(['btn-log']);
      break;
    case 'guessing':
      showBottomButtons(['btn-log']);
      break;
  }
}

// =====================================================
//  首页
// =====================================================
$('btn-create-room').addEventListener('click', () => {
  const n = $('nickname-input').value.trim();
  if (!n) return showToast('请输入昵称', 'error');
  socket.emit('create_room', { nickname: n });
});
$('btn-join-room').addEventListener('click', () => {
  const n = $('nickname-input').value.trim();
  const c = $('room-code-input').value.trim().toUpperCase();
  if (!n) return showToast('请输入昵称', 'error');
  if (c.length !== 6) return showToast('房间号为6位字符', 'error');
  socket.emit('join_room', { nickname: n, roomCode: c });
});
$('nickname-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-room').click(); });
$('room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join-room').click(); });

// =====================================================
//  大厅
// =====================================================
function renderLobbyPlayers(players) {
  const ring = $('lobby-player-ring');
  if (!ring) return;
  renderPlayerRing('lobby-player-ring', players);
  $('lobby-player-count').textContent = players.length;
  const connected = players.filter(p => p.isConnected).length;
  $('btn-start-game').disabled = connected < 1;
  $('lobby-hint').textContent = connected <= 1 ? '🎲 单人测试模式' : `👥 ${connected} 人已准备`;
}

$('btn-start-game').addEventListener('click', () => {
  if (!state.isHost) return showToast('只有房主可以开始游戏', 'error');
  socket.emit('start_game', { settings: gatherSettings() });
});
$('btn-leave').addEventListener('click', () => { socket.emit('leave_room'); resetToWelcome(); });
$('btn-copy-room').addEventListener('click', () => {
  const c = $('lobby-room-code').textContent;
  if (!c || c === '------') return;
  navigator.clipboard.writeText(c).then(() => showToast('📋 房间号已复制')).catch(() => showToast('复制失败', 'error'));
});
$('btn-settings-lobby')?.addEventListener('click', () => {
  if (!state.isHost) return showToast('只有房主可以修改设置', 'error');
  $('settings-modal').classList.add('active');
});

// 设置
$('btn-settings-close').addEventListener('click', () => {
  $('settings-modal').classList.remove('active');
  if (state.isHost) socket.emit('update_settings', { settings: gatherSettings() });
});
$('settings-modal')?.addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) $('settings-modal').classList.remove('active'); });
document.querySelectorAll('.btn-setting').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.setting; const dir = btn.dataset.action;
    const span = $(`setting-${key}`); const val = parseInt(span.textContent);
    const ranges = { spyCount: [1, 2], describeTime: [15, 20, 30, 60], voteTime: [30, 60, 90] };
    const range = ranges[key] || [1, 5]; const idx = range.indexOf(val);
    const nv = dir === 'inc' ? (idx < range.length - 1 ? range[idx + 1] : val) : (idx > 0 ? range[idx - 1] : val);
    if (nv !== val) span.textContent = nv;
  });
});
function gatherSettings() {
  return {
    spyCount: +$('setting-spyCount').textContent, whiteMode: $('setting-whiteMode').checked,
    guessEnabled: $('setting-guessEnabled').checked, describeTime: +$('setting-describeTime').textContent,
    voteTime: +$('setting-voteTime').textContent,
  };
}

// =====================================================
//  游戏交互
// =====================================================
// 词卡
setupWordCard();

// 描述按钮
$('btn-describe')?.addEventListener('click', () => {
  $('describe-modal').classList.add('active');
  $('describe-input').value = '';
  $('describe-input').focus();
});
$('btn-submit-describe').addEventListener('click', () => {
  const c = $('describe-input').value.trim();
  if (!c) return showToast('请输入描述', 'error');
  socket.emit('submit_description', { content: c });
  $('describe-modal').classList.remove('active');
});
$('describe-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-submit-describe').click(); });
$('btn-cancel-describe')?.addEventListener('click', () => $('describe-modal').classList.remove('active'));

// 投票
$('btn-vote')?.addEventListener('click', () => {
  if (state.currentPhase === 'voting') {
    $('vote-modal').classList.add('active');
  }
});

// 猜词
$('btn-guess')?.addEventListener('click', () => {
  $('guess-modal').classList.add('active');
  $('guess-input').value = '';
  $('guess-input').focus();
});
$('btn-submit-guess').addEventListener('click', () => {
  const w = $('guess-input').value.trim();
  if (!w) return showToast('请输入猜测的平民词', 'error');
  socket.emit('submit_guess', { guessedWord: w });
  $('guess-modal').classList.remove('active');
  $('btn-submit-guess').disabled = true;
});
$('guess-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-submit-guess').click(); });
$('btn-skip-guess').addEventListener('click', () => { socket.emit('skip_guess'); $('guess-modal').classList.remove('active'); });

// 确认词
$('btn-confirm-word')?.addEventListener('click', () => {
  $('btn-confirm-word').disabled = true;
  $('btn-confirm-word').textContent = '✓ 已确认';
  socket.emit('confirm_word');
});

// 投票网格
function renderVoteGrid(players) {
  const grid = $('vote-grid');
  if (!grid) return;
  grid.innerHTML = '';
  state.selectedVote = null;
  $('btn-confirm-vote').disabled = true;

  players.filter(p => p.isAlive).forEach(p => {
    const card = document.createElement('div');
    card.className = 'vote-player-card';
    const isMe = p.id === state.playerId;
    if (isMe) card.classList.add('self');
    card.innerHTML = `
      <div class="vote-avatar">${escapeHtml(p.name.charAt(0))}</div>
      <div class="vote-name">${escapeHtml(p.name)}${isMe ? '（你）' : ''}</div>
    `;
    if (!isMe) {
      card.addEventListener('click', () => {
        state.selectedVote = p.id;
        grid.querySelectorAll('.vote-player-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        $('btn-confirm-vote').disabled = false;
      });
    } else {
      card.addEventListener('click', () => showToast('不能投给自己', 'error'));
    }
    grid.appendChild(card);
  });
}

$('btn-confirm-vote').addEventListener('click', () => {
  if (state.selectedVote) {
    socket.emit('submit_vote', { targetId: state.selectedVote });
    showToast('🗳️ 投票已提交');
    $('vote-modal').classList.remove('active');
    $('btn-confirm-vote').disabled = true;
  }
});

// 描述计时器
let _descTimer = null;
function startDescTimer(sec) {
  if (_descTimer) clearInterval(_descTimer);
  const fill = $('desc-timer-fill');
  if (fill) { fill.style.transition = 'none'; fill.style.width = '100%'; setTimeout(() => { fill.style.transition = `width ${sec}s linear`; fill.style.width = '0%'; }, 50); }
  _descTimer = setInterval(() => { sec--; if (sec <= 0) clearInterval(_descTimer); }, 1000);
}

// 猜词计时器
let _guessTimer = null;
function startGuessTimer(sec) {
  if (_guessTimer) clearInterval(_guessTimer);
  const fill = $('guess-timer-fill');
  if (fill) { fill.style.transition = 'none'; fill.style.width = '100%'; setTimeout(() => { fill.style.transition = `width ${sec}s linear`; fill.style.width = '0%'; }, 50); }
  _guessTimer = setInterval(() => { sec--; if (sec <= 0) clearInterval(_guessTimer); }, 1000);
}

// 规则计时器
function startRulesTimer(sec) {
  const fill = $('rules-timer-fill');
  if (fill) { fill.style.transition = 'none'; fill.style.width = '100%'; setTimeout(() => { fill.style.transition = `width ${sec}s linear`; fill.style.width = '0%'; }, 50); }
  let n = sec;
  const t = setInterval(() => { n--; if (n > 0) $('rules-tip').textContent = `游戏将在 ${n} 秒后开始...`; else clearInterval(t); }, 1000);
}

// =====================================================
//  投票结果展示
// =====================================================
function showVoteResult(data) {
  showScreen('result');
  updateTitle(`${state.roomCode} | 结果`);
  const reveal = $('result-reveal-content');
  reveal.innerHTML = '';
  $('btn-continue').style.display = 'none';

  if (data.votes?.length) {
    const h = document.createElement('h3');
    h.textContent = '📊 投票详情'; h.style.marginBottom = '12px'; h.style.color = 'var(--brown-light)';
    reveal.appendChild(h);
    data.votes.forEach((v, i) => {
      const d = document.createElement('div');
      d.className = 'result-item'; d.style.animationDelay = `${i*0.12}s`;
      d.innerHTML = `<div class="result-player">${escapeHtml(v.voterName)} → ${escapeHtml(v.targetName)}</div>`;
      reveal.appendChild(d);
    });
  }

  const base = data.votes?.length || 0;
  if (data.tally) {
    setTimeout(() => {
      data.tally.forEach((t, i) => {
        const d = document.createElement('div');
        d.className = 'result-item'; d.style.animationDelay = `${(base+i)*0.12}s`;
        d.innerHTML = `<div class="result-player">${escapeHtml(t.playerName)}</div><div class="result-detail">${t.count} 票</div>`;
        if (data.eliminated && t.playerId === data.eliminated.id) d.classList.add('eliminated');
        reveal.appendChild(d);
      });
    }, base*120+400);
  }

  setTimeout(() => {
    if (data.eliminated) {
      const info = document.createElement('div');
      info.className = 'result-item eliminated';
      info.innerHTML = `<div class="result-player">🚫 ${escapeHtml(data.eliminated.name)} 被投出局！</div>`;
      reveal.appendChild(info);
    } else {
      const info = document.createElement('div');
      info.className = 'result-tie';
      info.textContent = '⚖️ 平票，本轮无人出局';
      reveal.appendChild(info);
    }
    $('btn-continue').style.display = 'block';
  }, (base+(data.tally?.length||0))*120+800);
}

$('btn-continue').addEventListener('click', () => { $('btn-continue').style.display = 'none'; showToast('等待下一阶段...'); });

// =====================================================
//  结算
// =====================================================
function showVictory(data) {
  showScreen('victory');
  updateTitle(`${state.roomCode} | 游戏结束`);
  const bg = $('victory-bg'); const txt = $('victory-text');
  const icon = $('victory-icon'); const sub = $('victory-subtitle');
  bg.className = 'victory-bg'; txt.className = 'victory-text';
  document.querySelectorAll('.confetti-container, .particle').forEach(e => e.remove());

  let bgCls='', txtCls='';
  if (data.isSpecialWin) { bgCls='special-bg'; txtCls='special-text'; icon.textContent='👑'; sub.textContent='完美表现！'; }
  else if (data.winner==='civilian') { bgCls='civilian-bg'; txtCls='civilian-text'; icon.textContent='🎉'; sub.textContent='平民成功找出卧底！'; }
  else if (data.winner==='spy') { bgCls='spy-bg'; txtCls='spy-text'; icon.textContent='🕵️'; sub.textContent='卧底完美潜伏到最后！'; }
  else if (data.winner==='white') { bgCls='white-bg'; txtCls='white-text'; icon.textContent='🎭'; sub.textContent='白板成功骗过所有人！'; }
  bg.classList.add(bgCls);
  txt.className = `victory-text ${txtCls}`;
  txt.textContent = data.winnerText || '游戏结束';

  if (data.wordPair) {
    $('victory-civilian-word').textContent = data.wordPair.civilian||'---';
    $('victory-spy-word').textContent = data.wordPair.spy||'---';
  }

  const grid = $('role-reveal-grid');
  grid.innerHTML = '';
  (data.roleReveal||[]).forEach(p => {
    const names = { civilian:'👤 平民', spy:'🕵️ 卧底', white:'⬜ 白板' };
    grid.innerHTML += `<div class="role-reveal-item ${p.isAlive?'':'dead'}"><div class="rr-name">${escapeHtml(p.name)}</div><div class="rr-role ${p.role}">${names[p.role]||p.role}</div></div>`;
  });

  const guessEl = grid.nextElementSibling;
  if (guessEl?.tagName==='P') guessEl.remove();
  if (data.guessResult) {
    const gi = document.createElement('p');
    gi.style.cssText = 'margin:12px 0;font-size:14px;color:var(--brown-light)';
    gi.textContent = data.guessResult.isCorrect ? `🎯 ${data.guessResult.playerName} 猜中了「${data.guessResult.guessedWord}」！` : `❌ ${data.guessResult.playerName} 猜错了`;
    grid.after(gi);
  }

  // 败者嘲讽
  const taunt = $('victory-taunt');
  const isLoser = (data.winner==='civilian'&&state.role!=='civilian')||(data.winner==='spy'&&state.role!=='spy')||(data.winner==='white'&&state.role!=='white')||(data.winner==='spy_or_white'&&state.role==='civilian');
  taunt.style.display = isLoser ? 'block' : 'none';

  // 特效
  const colors = data.isSpecialWin ? ['#ffd700','#ff6bc1','#ff4500','#7b68ee','#00ff88']
    : data.winner==='civilian' ? ['#ffd700','#ffec8b','#fff8dc']
    : data.winner==='spy' ? ['#9370db','#8a2be2','#da70d6']
    : ['#00ced1','#48d1cc','#7fffd4'];
  const n = data.isSpecialWin ? 60 : 30;
  const cc = document.createElement('div'); cc.className = 'confetti-container'; bg.appendChild(cc);
  for (let i=0;i<n;i++){const e=document.createElement('div');e.className='confetti';e.style.cssText=`left:${Math.random()*100}%;background:${colors[i%colors.length]};animation-duration:${2+Math.random()*3}s;animation-delay:${Math.random()*2}s`;cc.appendChild(e);}
}

// =====================================================
//  再来一局
// =====================================================
$('btn-play-again').addEventListener('click', () => { if(state.isHost) socket.emit('new_game'); else showToast('等待房主开始新游戏...'); });
$('btn-back-lobby').addEventListener('click', () => { if(state.isHost) socket.emit('new_game'); else showToast('等待房主操作...'); });

// =====================================================
//  Socket 事件
// =====================================================
// 房间
socket.on('room_created', d => {
  Object.assign(state, { playerId: d.playerId, roomCode: d.roomCode, isHost: true });
  showScreen('lobby');
  $('lobby-room-code').textContent = d.roomCode;
  renderLobbyPlayers(d.room.players);
  updateTitle(`${d.roomCode} | 大厅`);
});
socket.on('room_joined', d => {
  Object.assign(state, { playerId: d.playerId, roomCode: d.room.code, isHost: d.room.hostId === d.playerId });
  showScreen('lobby');
  $('lobby-room-code').textContent = d.room.code;
  renderLobbyPlayers(d.room.players);
  updateTitle(`${d.room.code} | 大厅`);
});
socket.on('player_joined', d => renderLobbyPlayers(d.players));
socket.on('player_left', d => renderLobbyPlayers(d.players));
socket.on('player_disconnected', d => showToast(`${d.name} 断线了`, 'error'));
socket.on('kicked', () => { showToast('你被移出了房间', 'error'); resetToWelcome(); });

// 游戏阶段
socket.on('phase_changed', d => {
  state.currentPhase = d.phase;
  switch (d.phase) {
    case 'starting': showToast('游戏即将开始...'); updateTitle(`${state.roomCode} | 准备中`); break;
    case 'rules': showScreen('rules'); startRulesTimer(d.duration||6); updateTitle(`${state.roomCode} | 规则`); break;
    case 'dealing':
      enterGamePhase('dealing', d);
      updateTitle(`${state.roomCode} | 看词`);
      break;
    case 'describing':
      enterGamePhase('describing', d);
      $('game-phase-info').textContent = `第 ${d.round||1} 回合 · 描述中`;
      updateTitle(`${state.roomCode} | 描述中`);
      showBottomButtons(['btn-log']);
      break;
    case 'voting':
      enterGamePhase('voting', d);
      $('game-phase-info').textContent = `第 ${d.round||1} 回合 · 投票`;
      updateTitle(`${state.roomCode} | 投票`);
      showBottomButtons(['btn-vote', 'btn-log']);
      if (d.players) {
        renderPlayerRing('game-player-ring', d.players, {});
        setCenterInfo('voting', d.round||1);
        updateVoteDots(d.players, []);
      }
      break;
  }
});

// 角色
socket.on('your_role', d => {
  setWordCard(d.role, d.word);
  // 重置翻牌
  $('word-card-toggle').classList.remove('hidden');
  $('btn-confirm-word').style.display = 'none';
  $('btn-confirm-word').disabled = false;
  $('btn-confirm-word').textContent = '✓ 确认';
});

socket.on('confirm_progress', d => {
  // 不用进度条了，简单提示
});

// 描述
socket.on('describe_turn', d => {
  const isMe = d.speakerId === state.playerId;
  $('game-phase-info').textContent = isMe ? '🎤 轮到你了！' : `🎤 ${escapeHtml(d.speakerName)} 描述中...`;
  $('modal-desc-hint').textContent = `用一句话描述你的词语：`;
  setCenterInfo('describing', state.currentPhase === 'describing' ? 1 : 1, d.describedIds?.length, d.timeLimit);

  if (isMe) {
    showBottomButtons(['btn-describe', 'btn-log']);
  } else {
    showBottomButtons(['btn-log']);
  }

  if (d.alivePlayers) {
    renderPlayerRing('game-player-ring', d.alivePlayers, { currentSpeakerId: d.speakerId, describedIds: d.describedIds || [] });
    updateVoteDots(d.alivePlayers, []);
  }
  $('center-timer').textContent = `${d.timeLimit}s`;
  $('center-timer').style.display = 'block';

  // 计时器
  if (isMe) startDescTimer(d.timeLimit);
});

socket.on('description_received', d => {
  addSideDescription(d.playerName, d.description);
});

socket.on('all_descriptions', d => {
  clearSideDescriptions();
  d.descriptions.forEach(x => addSideDescription(x.playerName, x.description));
  showBottomButtons(['btn-vote', 'btn-log']);
  $('game-phase-info').textContent = '所有人描述完毕！';
  $('center-timer').style.display = 'none';
});

// 投票
let _votePlayerList = [];
socket.on('vote_players', d => {
  _votePlayerList = d.players;
  renderPlayerRing('game-player-ring', d.players, {});
  renderVoteGrid(d.players);
  updateVoteDots(d.players, []);
  $('vote-count').textContent = '0';
  $('vote-total').textContent = d.players.filter(p=>p.isAlive).length;
  setCenterInfo('voting', state.currentPhase === 'voting' ? 1 : 1, undefined, $('vote-total').textContent * 2 || 60);
});

socket.on('vote_progress', d => {
  $('vote-count').textContent = d.votedCount;
  $('vote-total').textContent = d.totalCount;
});

socket.on('vote_status', d => {
  if (_votePlayerList.length) updateVoteDots(_votePlayerList, d.votedPlayerIds || []);
});

socket.on('vote_result', d => {
  showVoteResult(d);
});

// 猜词
socket.on('guess_phase', d => {
  showScreen('game');
  updateTitle(`${state.roomCode} | 猜词`);
  $('game-phase-info').textContent = '🤔 猜词阶段';
  setCenterInfo('guessing', d.round||1);

  if (d.canGuess) {
    showBottomButtons(['btn-guess', 'btn-log']);
    $('guess-modal').classList.add('active');
    $('guess-input').value = '';
    $('guess-input').focus();
    $('btn-submit-guess').disabled = false;
    $('btn-submit-guess').textContent = '猜';
    startGuessTimer(d.timeLimit || 30);
  } else {
    showBottomButtons(['btn-log']);
    const names = d.guessingPlayerNames || [];
    showToast(names.length ? `${names.join('、')} 正在猜词...` : '等待猜词...');
  }
});

socket.on('guess_result', d => { showToast(d.correct ? '🎯 猜对了！' : '❌ 猜错了'); });
socket.on('guess_made', d => showToast(`${d.playerName} 提交了猜测`));
socket.on('guess_skipped', () => showToast('你放弃了猜词'));

// 结束
socket.on('game_ended', d => showVictory(d));

socket.on('return_to_lobby', d => {
  state.isHost = d.room.hostId === state.playerId;
  showScreen('lobby');
  $('lobby-room-code').textContent = d.room.code;
  renderLobbyPlayers(d.room.players);
  updateTitle(`${d.room.code} | 大厅`);
});

// 错误
socket.on('error', d => showToast(d.msg || '操作失败', 'error'));

// =====================================================
//  初始化
// =====================================================
window.addEventListener('beforeunload', () => { if (state.roomCode) socket.emit('leave_room'); });
console.log('🎲 谁是卧底 · 桌游派对 已加载');
