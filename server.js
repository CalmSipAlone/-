const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// ============ 加载词库 ============
const wordsPath = path.join(__dirname, 'words.json');
const wordPairs = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));

// ============ 配置 ============
const PORT = process.env.PORT || 3000;
const DEFAULT_SETTINGS = {
  spyCount: 1,
  whiteMode: false,
  guessEnabled: true,
  describeTime: 30,
  voteTime: 60,
  guessTime: 30,
  roundLimit: 3,
};

// ============ 服务器设置 ============
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ============ 数据存储 ============
const rooms = new Map();

// ============ 工具函数 ============
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function pickWordPair(usedIndices) {
  const available = wordPairs.filter((_, i) => !usedIndices.has(i));
  if (available.length === 0) {
    // 词库用完，重置
    usedIndices.clear();
    return pickWordPair(usedIndices);
  }
  const pool = available.length > 0 ? available : wordPairs;
  const pair = pool[Math.floor(Math.random() * pool.length)];
  const idx = wordPairs.indexOf(pair);
  usedIndices.add(idx);
  return pair;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============ 房间管理 ============
class Room {
  constructor(code, hostId, settings = {}) {
    this.code = code;
    this.hostId = hostId;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.players = [];
    this.state = 'waiting'; // waiting | playing | ended
    this.game = null;
    this.timers = {};
    this.usedWordIndices = new Set();
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id);
  }

  getAlivePlayers() {
    return this.players.filter(p => p.isAlive);
  }

  addPlayer(id, name) {
    const player = {
      id,
      name,
      isAlive: true,
      role: null,
      word: null,
      hasGuessed: false,
      isHost: id === this.hostId,
      isConnected: true,
      description: null,
      voted: false,
    };
    this.players.push(player);
    return player;
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return null;
    const [player] = this.players.splice(idx, 1);
    if (this.hostId === id && this.players.length > 0) {
      this.hostId = this.players[0].id;
      this.players[0].isHost = true;
    }
    return player;
  }

  toJSON() {
    return {
      code: this.code,
      hostId: this.hostId,
      settings: this.settings,
      state: this.state,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        role: this.state === 'ended' ? p.role : undefined,
        isHost: p.isHost,
        isConnected: p.isConnected,
        hasGuessed: p.hasGuessed,
      })),
    };
  }

  broadcast(event, data) {
    io.to(this.code).emit(event, data);
  }

  sendTo(playerId, event, data) {
    io.to(playerId).emit(event, data);
  }

  clearTimers() {
    Object.values(this.timers).forEach(t => clearTimeout(t));
    Object.values(this.timers).forEach(t => clearInterval(t));
    this.timers = {};
  }
}

// ============ 游戏逻辑 ============
class Game {
  constructor(room) {
    this.room = room;
    this.round = 1;
    this.phase = 'dealing';
    this.wordPair = null;
    this.currentSpeakerIndex = 0;
    this.speakOrder = [];
    this.votes = {};
    this.guessResult = null;
    this.eliminated = [];
    this.eliminatedThisRound = [];
    this.allConfirmed = false;
    this.confirmedPlayers = new Set();
    this.phaseStartTime = Date.now();
  }

  // ===== 发牌 =====
  deal() {
    const room = this.room;
    const players = room.players.filter(p => p.isConnected);
    const aliveCount = players.length;

    // 选词对
    this.wordPair = pickWordPair(room.usedWordIndices);

    // 分配角色
    const shuffled = shuffleArray(players);
    const spyCount = Math.min(room.settings.spyCount, Math.floor(aliveCount / 3));

    // 确定角色分配
    const roles = [];
    for (let i = 0; i < spyCount; i++) roles.push('spy');
    if (room.settings.whiteMode && aliveCount >= 5) {
      roles.push('white');
    }
    while (roles.length < aliveCount) roles.push('civilian');
    const assignedRoles = shuffleArray(roles);

    // 分配词语
    shuffled.forEach((player, i) => {
      const role = assignedRoles[i];
      player.role = role;
      player.isAlive = true;
      player.description = null;
      player.voted = false;
      player.hasGuessed = false;

      if (role === 'spy') {
        player.word = this.wordPair.spy;
      } else if (role === 'civilian') {
        player.word = this.wordPair.civilian;
      } else {
        player.word = null; // 白板没有词
      }
    });

    room.players.forEach(p => {
      if (!p.isConnected) {
        p.role = 'civilian';
        p.word = this.wordPair.civilian;
        p.isAlive = false;
      }
    });

    this.phase = 'dealing';
    this.confirmedPlayers = new Set();
    this.eliminatedThisRound = [];

    // 逐个发词
    room.players.forEach(p => {
      room.sendTo(p.id, 'your_role', {
        role: p.role,
        word: p.word,
        wordPair: null,
      });
    });

    room.broadcast('phase_changed', { phase: 'dealing', round: this.round });
  }

  // ===== 确认看词 =====
  confirmWord(playerId) {
    this.confirmedPlayers.add(playerId);
    const aliveConnected = this.room.players.filter(p => p.isConnected && p.isAlive);
    const allConfirmed = aliveConnected.every(p => this.confirmedPlayers.has(p.id));

    if (allConfirmed) {
      this.allConfirmed = true;
      this.startDescribePhase();
    } else {
      this.room.broadcast('confirm_progress', {
        confirmed: this.confirmedPlayers.size,
        total: aliveConnected.length,
      });
    }
  }

  // ===== 描述阶段 =====
  startDescribePhase() {
    this.phase = 'describing';
    this.speakOrder = shuffleArray(this.room.players.filter(p => p.isAlive && p.isConnected));
    this.currentSpeakerIndex = 0;
    this.room.broadcast('phase_changed', { phase: 'describing', round: this.round });
    this.startSpeakerTurn();
  }

  startSpeakerTurn() {
    // 清除旧timer
    if (this.room.timers.describeTimer) {
      clearTimeout(this.room.timers.describeTimer);
    }

    const aliveSpeakers = this.speakOrder.filter(p => p.isAlive && p.isConnected);
    if (this.currentSpeakerIndex >= aliveSpeakers.length) {
      this.endDescribePhase();
      return;
    }

    const speaker = aliveSpeakers[this.currentSpeakerIndex];
    const timeLimit = this.room.settings.describeTime;

    this.room.broadcast('describe_turn', {
      speakerId: speaker.id,
      speakerName: speaker.name,
      timeLimit,
      index: this.currentSpeakerIndex,
      total: aliveSpeakers.length,
    });

    // 倒计时
    this.room.timers.describeTimer = setTimeout(() => {
      this.advanceSpeaker();
    }, timeLimit * 1000);
  }

  submitDescription(playerId, content) {
    if (this.phase !== 'describing') return;

    const aliveSpeakers = this.speakOrder.filter(p => p.isAlive && p.isConnected);
    if (this.currentSpeakerIndex >= aliveSpeakers.length) return;

    const speaker = aliveSpeakers[this.currentSpeakerIndex];
    if (speaker.id !== playerId) return;

    speaker.description = content.trim().substring(0, 100);
    this.room.broadcast('description_received', {
      playerId: speaker.id,
      playerName: speaker.name,
      description: speaker.description,
    });

    this.advanceSpeaker();
  }

  advanceSpeaker() {
    if (this.room.timers.describeTimer) {
      clearTimeout(this.room.timers.describeTimer);
    }

    this.currentSpeakerIndex++;
    const aliveSpeakers = this.speakOrder.filter(p => p.isAlive && p.isConnected);

    if (this.currentSpeakerIndex >= aliveSpeakers.length) {
      // 所有人都描述完了
      this.endDescribePhase();
    } else {
      this.startSpeakerTurn();
    }
  }

  endDescribePhase() {
    this.phase = 'voting';
    this.votes = {};
    this.room.players.forEach(p => { p.voted = false; });

    this.room.broadcast('all_descriptions', {
      descriptions: this.speakOrder
        .filter(p => p.description)
        .map(p => ({ playerId: p.id, playerName: p.name, description: p.description })),
    });

    setTimeout(() => {
      this.startVotePhase();
    }, 3000); // 3秒后开始投票，让大家看看所有人的描述
  }

  // ===== 投票阶段 =====
  startVotePhase() {
    this.phase = 'voting';
    const timeLimit = this.room.settings.voteTime;

    this.room.broadcast('phase_changed', {
      phase: 'voting',
      timeLimit,
      round: this.round,
    });

    // 发送存活玩家列表用于投票
    const alivePlayers = this.room.players.filter(p => p.isAlive).map(p => ({
      id: p.id,
      name: p.name,
      isAlive: p.isAlive,
    }));
    this.room.broadcast('vote_players', { players: alivePlayers });

    this.room.timers.voteTimer = setTimeout(() => {
      this.processVotes();
    }, timeLimit * 1000);
  }

  submitVote(voterId, targetId) {
    if (this.phase !== 'voting') return;

    const voter = this.room.getPlayer(voterId);
    if (!voter || !voter.isAlive || voter.voted) return;

    const target = this.room.getPlayer(targetId);
    if (!target || !target.isAlive) return;

    if (voterId === targetId) return; // 不能投自己

    this.votes[voterId] = targetId;
    voter.voted = true;

    const aliveCount = this.room.players.filter(p => p.isAlive && p.isConnected).length;
    const votedCount = Object.keys(this.votes).length;

    this.room.broadcast('vote_progress', {
      votedCount,
      totalCount: aliveCount,
    });

    // 所有人都投票了
    if (votedCount >= aliveCount) {
      clearTimeout(this.room.timers.voteTimer);
      this.processVotes();
    }
  }

  processVotes() {
    if (this.phase !== 'voting') return;
    this.phase = 'processing';

    // 统计
    const tally = {};
    Object.values(this.votes).forEach(targetId => {
      tally[targetId] = (tally[targetId] || 0) + 1;
    });

    let maxVotes = 0;
    let maxPlayers = [];
    Object.entries(tally).forEach(([id, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        maxPlayers = [id];
      } else if (count === maxVotes) {
        maxPlayers.push(id);
      }
    });

    const eliminated = maxPlayers.length === 1 ? this.room.getPlayer(maxPlayers[0]) : null;

    if (eliminated) {
      eliminated.isAlive = false;
      this.eliminatedThisRound.push(eliminated);
      this.eliminated.push(eliminated);
    }

    // 展示投票结果
    const votesData = Object.entries(this.votes).map(([vid, tid]) => {
      const v = this.room.getPlayer(vid);
      const t = this.room.getPlayer(tid);
      return { voterName: v ? v.name : '未知', targetName: t ? t.name : '未知' };
    });

    this.room.broadcast('vote_result', {
      votes: votesData,
      tally: Object.entries(tally).map(([id, count]) => ({
        playerId: id,
        playerName: this.room.getPlayer(id)?.name || '未知',
        count,
      })),
      eliminated: eliminated ? { id: eliminated.id, name: eliminated.name } : null,
    });

    // 3秒后进入结算
    setTimeout(() => {
      this.checkWinCondition();
    }, 3000);
  }

  // ===== 胜负判定 =====
  checkWinCondition() {
    const alive = this.room.players.filter(p => p.isAlive && p.isConnected);
    const spies = alive.filter(p => p.role === 'spy');
    const whites = alive.filter(p => p.role === 'white');
    const civilians = alive.filter(p => p.role === 'civilian');

    // 平民全灭 → 卧底/白板胜
    if (civilians.length === 0) {
      this.endGame('spy_or_white', false);
      return;
    }

    // 卧底和白板全灭 → 平民胜
    if (spies.length === 0 && whites.length === 0) {
      this.endGame('civilian', false);
      return;
    }

    // 存活 ≤ 3 人，且还有卧底/白板
    if (alive.length <= 3) {
      if (spies.length > 0 || whites.length > 0) {
        this.endGame('spy_or_white', false);
        return;
      }
    }

    // 到达轮数限制 → 平民胜（卧底没能在限时内获胜）
    if (this.round >= this.room.settings.roundLimit) {
      this.endGame('civilian', false);
      return;
    }

    // 游戏继续 → 进入猜词阶段
    this.startGuessPhase();
  }

  // ===== 猜词阶段 =====
  startGuessPhase() {
    if (!this.room.settings.guessEnabled) {
      this.nextRound();
      return;
    }

    const alive = this.room.players.filter(p => p.isAlive && p.isConnected);
    const canGuess = alive.filter(p =>
      (p.role === 'spy' || p.role === 'white') && !p.hasGuessed
    );

    if (canGuess.length === 0) {
      this.nextRound();
      return;
    }

    this.phase = 'guessing';
    const timeLimit = this.room.settings.guessTime;

    // 通知每个人是否能猜词
    this.room.players.forEach(p => {
      const guesser = canGuess.find(g => g.id === p.id);
      this.room.sendTo(p.id, 'guess_phase', {
        canGuess: !!guesser,
        timeLimit,
        round: this.round,
      });
    });

    // 其他人看到等待
    this.room.broadcast('phase_changed', {
      phase: 'guessing',
      guessingPlayerNames: canGuess.map(g => g.name),
    });

    // 提交猜词的 handler 在 socket 事件里

    this.room.timers.guessTimer = setTimeout(() => {
      this.afterGuess();
    }, timeLimit * 1000);
  }

  submitGuess(playerId, guessedWord) {
    if (this.phase !== 'guessing') return;

    const player = this.room.getPlayer(playerId);
    if (!player || !player.isAlive) return;
    if (player.role !== 'spy' && player.role !== 'white') return;
    if (player.hasGuessed) return;

    player.hasGuessed = true;
    const isCorrect = guessedWord.trim() === this.wordPair.civilian;

    this.guessResult = {
      playerId: player.id,
      playerName: player.name,
      guessedWord: guessedWord.trim(),
      isCorrect,
    };

    // 通知猜词者结果
    this.room.sendTo(playerId, 'guess_result', {
      correct: isCorrect,
      word: this.wordPair.civilian,
    });

    // 通知其他人有人猜了（不公布内容）
    this.room.broadcast('guess_made', {
      playerName: player.name,
    });

    // 猜对了直接结束游戏
    if (isCorrect) {
      clearTimeout(this.room.timers.guessTimer);
      this.endGame(player.role === 'spy' ? 'spy_special' : 'white_special', true);
      return;
    }

    // 猜错了继续
    this.afterGuess();
  }

  skipGuess(playerId) {
    if (this.phase !== 'guessing') return;
    const player = this.room.getPlayer(playerId);
    if (!player) return;
    if (player.role !== 'spy' && player.role !== 'white') return;

    player.hasGuessed = true;
    this.room.sendTo(playerId, 'guess_skipped', {});

    // 检查是否所有可猜的人都已操作
    const alive = this.room.players.filter(p => p.isAlive && p.isConnected);
    const remaining = alive.filter(p =>
      (p.role === 'spy' || p.role === 'white') && !p.hasGuessed
    );
    if (remaining.length === 0) {
      clearTimeout(this.room.timers.guessTimer);
      this.afterGuess();
    }
  }

  afterGuess() {
    if (this.phase !== 'guessing') return;
    if (this.room.timers.guessTimer) {
      clearTimeout(this.room.timers.guessTimer);
    }
    this.nextRound();
  }

  // ===== 下一轮 =====
  nextRound() {
    this.round++;
    this.currentSpeakerIndex = 0;
    this.eliminatedThisRound = [];
    this.guessResult = null;

    // 重新发牌
    this.deal();
  }

  // ===== 游戏结束 =====
  endGame(winner, isSpecialWin) {
    this.phase = 'ended';
    this.room.state = 'ended';
    this.room.clearTimers();

    let winnerLabel = '';
    let winnerText = '';

    switch (winner) {
      case 'civilian':
        winnerLabel = 'civilian';
        winnerText = '🎉 平民获胜！';
        break;
      case 'spy_or_white':
        // 判断是卧底还是白板
        const alive = this.room.players.filter(p => p.isAlive && p.isConnected);
        const hasSpy = alive.some(p => p.role === 'spy');
        winnerLabel = hasSpy ? 'spy' : 'white';
        winnerText = hasSpy ? '🕵️ 卧底获胜！' : '🎭 白板成功潜伏！';
        break;
      case 'spy_special':
        winnerLabel = 'spy';
        winnerText = '👑 卧底完美伪装！';
        break;
      case 'white_special':
        winnerLabel = 'white';
        winnerText = '👑 白板影帝/影后！';
        break;
    }

    // 收集所有角色信息
    const roleReveal = this.room.players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      word: p.word,
      isAlive: p.isAlive,
    }));

    this.room.broadcast('game_ended', {
      winner: winnerLabel,
      winnerText,
      isSpecialWin,
      roleReveal,
      wordPair: this.wordPair,
      eliminated: this.eliminated.map(e => ({ id: e.id, name: e.name })),
      guessResult: this.guessResult,
      rounds: this.round,
    });
  }

  toJSON() {
    return {
      round: this.round,
      phase: this.phase,
      wordPair: this.phase === 'ended' ? this.wordPair : undefined,
    };
  }
}

// ============ Socket.IO 事件处理 ============
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // ===== 创建房间 =====
  socket.on('create_room', ({ nickname, settings } = {}) => {
    if (!nickname || nickname.trim().length === 0) {
      socket.emit('error', { msg: '请输入昵称' });
      return;
    }
    const name = nickname.trim().substring(0, 12);
    const code = generateRoomCode();
    const room = new Room(code, socket.id, settings);

    socket.join(code);
    room.addPlayer(socket.id, name);
    rooms.set(code, room);

    socket.emit('room_created', {
      roomCode: code,
      playerId: socket.id,
      room: room.toJSON(),
    });

    console.log(`[创建房间] ${code} - ${name}`);
  });

  // ===== 加入房间 =====
  socket.on('join_room', ({ roomCode, nickname } = {}) => {
    if (!nickname || nickname.trim().length === 0) {
      socket.emit('error', { msg: '请输入昵称' });
      return;
    }
    const code = (roomCode || '').toUpperCase().trim();
    const name = nickname.trim().substring(0, 12);

    const room = rooms.get(code);
    if (!room) {
      socket.emit('error', { msg: '房间不存在' });
      return;
    }
    if (room.state !== 'waiting' && room.state !== 'ended') {
      socket.emit('error', { msg: '游戏已开始，无法加入' });
      return;
    }
    if (room.players.length >= 10) {
      socket.emit('error', { msg: '房间已满（最多10人）' });
      return;
    }
    if (room.players.some(p => p.name === name)) {
      socket.emit('error', { msg: '该昵称已被使用' });
      return;
    }

    socket.join(code);
    room.addPlayer(socket.id, name);

    socket.emit('room_joined', {
      playerId: socket.id,
      room: room.toJSON(),
    });

    room.broadcast('player_joined', {
      player: room.getPlayer(socket.id),
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isConnected: p.isConnected,
      })),
    });

    console.log(`[加入房间] ${code} - ${name}`);
  });

  // ===== 离开房间 =====
  socket.on('leave_room', () => {
    handlePlayerLeave(socket);
  });

  // ===== 开始游戏 =====
  socket.on('start_game', ({ settings } = {}) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;

    if (room.hostId !== socket.id) {
      socket.emit('error', { msg: '只有房主可以开始游戏' });
      return;
    }

    const connected = room.players.filter(p => p.isConnected);
    if (connected.length < 4) {
      socket.emit('error', { msg: '至少需要4名玩家才能开始' });
      return;
    }

    // 更新设置
    if (settings) {
      Object.assign(room.settings, settings);
    }

    room.state = 'playing';
    room.clearTimers();

    // 创建游戏
    const game = new Game(room);
    room.game = game;

    room.broadcast('phase_changed', { phase: 'starting' });

    setTimeout(() => {
      game.deal();
    }, 1500);
  });

  // ===== 确认看词 =====
  socket.on('confirm_word', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.game) return;
    if (room.game.phase !== 'dealing') return;

    room.game.confirmWord(socket.id);
  });

  // ===== 提交描述 =====
  socket.on('submit_description', ({ content } = {}) => {
    if (!content || content.trim().length === 0) {
      socket.emit('error', { msg: '描述不能为空' });
      return;
    }
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.game) return;

    room.game.submitDescription(socket.id, content.trim());
  });

  // ===== 提交投票 =====
  socket.on('submit_vote', ({ targetId } = {}) => {
    if (!targetId) return;
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.game) return;

    room.game.submitVote(socket.id, targetId);
  });

  // ===== 提交猜词 =====
  socket.on('submit_guess', ({ guessedWord } = {}) => {
    if (!guessedWord || guessedWord.trim().length === 0) return;
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.game) return;

    room.game.submitGuess(socket.id, guessedWord.trim());
  });

  // ===== 跳过猜词 =====
  socket.on('skip_guess', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room || !room.game) return;

    room.game.skipGuess(socket.id);
  });

  // ===== 再来一局 =====
  socket.on('new_game', () => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;

    if (room.hostId !== socket.id) {
      socket.emit('error', { msg: '只有房主可以开始新游戏' });
      return;
    }

    room.state = 'waiting';
    room.game = null;
    room.clearTimers();

    room.players.forEach(p => {
      p.isAlive = true;
      p.role = null;
      p.word = null;
      p.hasGuessed = false;
      p.description = null;
      p.voted = false;
    });

    room.broadcast('return_to_lobby', { room: room.toJSON() });
  });

  // ===== 更新设置 =====
  socket.on('update_settings', ({ settings } = {}) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.state !== 'waiting') return;

    Object.assign(room.settings, settings);
    room.broadcast('settings_updated', { settings: room.settings });
  });

  // ===== 踢人 =====
  socket.on('kick_player', ({ playerId } = {}) => {
    const room = findRoomByPlayerId(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.state !== 'waiting') return;

    const target = room.getPlayer(playerId);
    if (!target || target.isHost) return;

    io.to(playerId).emit('kicked', {});
    io.sockets.sockets.get(playerId)?.leave(room.code);
    room.removePlayer(playerId);

    room.broadcast('player_left', {
      playerId,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isConnected: p.isConnected,
      })),
    });
  });

  // ===== 断线处理 =====
  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.id}`);
    handlePlayerDisconnect(socket);
  });
});

// ============ 辅助函数 ============
function findRoomByPlayerId(playerId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === playerId)) return room;
  }
  return null;
}

function handlePlayerLeave(socket) {
  const room = findRoomByPlayerId(socket.id);
  if (!room) return;

  const player = room.getPlayer(socket.id);
  if (!player) return;

  socket.leave(room.code);

  if (room.state === 'waiting' || room.state === 'ended') {
    room.removePlayer(socket.id);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      console.log(`[删除房间] ${room.code}（无人）`);
      return;
    }

    room.broadcast('player_left', {
      playerId: socket.id,
      name: player.name,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isConnected: p.isConnected,
      })),
    });
  } else {
    // 游戏中：标记为离线
    player.isConnected = false;
    room.broadcast('player_disconnected', {
      playerId: socket.id,
      name: player.name,
    });
  }
}

function handlePlayerDisconnect(socket) {
  const room = findRoomByPlayerId(socket.id);
  if (!room) return;

  const player = room.getPlayer(socket.id);
  if (!player) return;

  player.isConnected = false;

  if (room.state === 'waiting' || room.state === 'ended') {
    room.removePlayer(socket.id);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      console.log(`[删除房间] ${room.code}（全部断开）`);
      return;
    }

    room.broadcast('player_left', {
      playerId: socket.id,
      name: player.name,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isConnected: p.isConnected,
      })),
    });
  } else {
    room.broadcast('player_disconnected', {
      playerId: socket.id,
      name: player.name,
    });

    // 如果是当前描述者，跳过
    if (room.game && room.game.phase === 'describing') {
      const aliveSpeakers = room.game.speakOrder.filter(p => p.isAlive && p.isConnected);
      if (room.game.currentSpeakerIndex < aliveSpeakers.length) {
        const speaker = aliveSpeakers[room.game.currentSpeakerIndex];
        if (speaker && speaker.id === socket.id) {
          // 给5秒重连时间
          setTimeout(() => {
            const p = room.getPlayer(socket.id);
            if (p && !p.isConnected) {
              room.game.advanceSpeaker();
            }
          }, 5000);
        }
      }
    }
  }
}

// ============ 启动服务器 ============
server.listen(PORT, () => {
  console.log(`\n  🎭 谁是卧底 - 游戏服务器`);
  console.log(`  ─────────────────────`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  词库: ${wordPairs.length} 组词对\n`);
});
