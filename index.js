// ── LOAD ENV PERTAMA SEBELUM APAPUN ──
require('dotenv').config();

// ── DATABASE SQLite (persistent di ./data/bot.db) ──
const {
  initDatabase,
  dbGetMemory, dbSaveMemory, dbDeleteMemory,
  dbGetCooldown, dbSetCooldown, dbDeleteCooldown,
  dbGetAllBots, dbInsertBot, dbGetBotByToken, dbGetBotByClientId, dbDeleteBot,
} = require('./db');

const { loadAndStartAllBots, startChildBot, announceToAllBots, getRunningBots } = require('./botManager');

const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  REST, Routes, SlashCommandBuilder, ChannelType, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ButtonBuilder, ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  VoiceConnectionStatus,
} = require('@discordjs/voice');
const Groq = require('groq-sdk');

// ── VALIDASI ENV WAJIB ──
const REQUIRED_ENV = ['DISCORD_TOKEN', 'CLIENT_ID'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ ENV "${key}" belum diset di file .env!`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ── GROQ API KEY ROTATION ──
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

if (GROQ_KEYS.length === 0) {
  console.warn('⚠️ Tidak ada GROQ_API_KEY yang diset. Fitur AI tidak akan berfungsi.');
}

let currentGroqIndex = 0;
function getGroqClient() { return new Groq({ apiKey: GROQ_KEYS[currentGroqIndex] }); }
function rotateGroqKey() {
  currentGroqIndex = (currentGroqIndex + 1) % Math.max(GROQ_KEYS.length, 1);
  console.log(`🔄 Groq key rotated ke key ${currentGroqIndex + 1}`);
}

const ALLOWED_ROLES  = (process.env.ALLOWED_ROLES || '').split(',').map(r => r.trim()).filter(Boolean);
const ALLOWED_GUILDS = (process.env.ALLOWED_GUILDS || '').split(',').map(g => g.trim()).filter(Boolean);
const ADMIN_GUILD_IDS = (process.env.ADMIN_GUILD_IDS || '').split(',').map(g => g.trim()).filter(Boolean);
const ADMIN_ROLE_IDS  = (process.env.ADMIN_ROLE_IDS || '').split(',').map(r => r.trim()).filter(Boolean);

function isAdminGuild(guildId) {
  if (ADMIN_GUILD_IDS.length === 0) return false;
  return ADMIN_GUILD_IDS.includes(guildId);
}
function isAdminRole(member) {
  if (ADMIN_ROLE_IDS.length === 0) return false;
  return member.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
}
function hasPermission(member) {
  if (ALLOWED_ROLES.length === 0) return true;
  return member.roles.cache.some(role => ALLOWED_ROLES.includes(role.id));
}
function isAllowedGuild(guildId) {
  if (ALLOWED_GUILDS.length === 0) return true;
  return ALLOWED_GUILDS.includes(guildId);
}

const TRIGGER_WORDS = (process.env.TRIGGER_WORDS || 'ai').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
const THREAD_CHANNEL_WHITELIST = (process.env.THREAD_CHANNEL_IDS || '').split(',').map(c => c.trim()).filter(Boolean);
function isThreadAllowed(channelId) {
  if (THREAD_CHANNEL_WHITELIST.length === 0) return true;
  return THREAD_CHANNEL_WHITELIST.includes(channelId);
}

// ── MEMORY CACHE (langsung tulis ke SQLite, tanpa idle timer) ──
const MAX_MEMORY = 20;
const memoryCache = new Map();

function getCacheEntry(id) {
  if (!memoryCache.has(id))
    memoryCache.set(id, { messages: [], isThread: false, loaded: false });
  return memoryCache.get(id);
}

async function getMemory(id) {
  const cache = getCacheEntry(id);
  if (!cache.loaded) {
    const doc = dbGetMemory(id);
    if (doc && doc.messages.length > 0) {
      cache.messages = doc.messages.slice(-MAX_MEMORY).map(m => ({ role: m.role, content: m.content }));
      cache.isThread = doc.isThread;
    }
    cache.loaded = true;
  }
  return cache.messages.slice();
}

function addMemoryLocal(id, role, text, isThread = false) {
  const cache = getCacheEntry(id);
  cache.loaded = true;
  cache.isThread = isThread;
  cache.messages.push({ role, content: text });
  if (cache.messages.length > MAX_MEMORY) cache.messages = cache.messages.slice(-MAX_MEMORY);
  try {
    dbSaveMemory(id, cache.messages, cache.isThread);
  } catch (err) {
    console.error(`SQLite save error (${id}):`, err.message);
  }
}

async function clearMemory(id) {
  memoryCache.delete(id);
  dbDeleteMemory(id);
}

// ── COOLDOWN & REPEAT ──
const repeatMap = new Map();
const REPEAT_LIMIT = 3;
const REPEAT_WINDOW = 60 * 1000;
const REPEAT_TIMEOUT = 2 * 60 * 60 * 1000;
const REPEAT_BOT_COOLDOWN = 24 * 60 * 60 * 1000;

function setCooldown(userId) {
  dbSetCooldown(userId, Date.now() + REPEAT_BOT_COOLDOWN);
}
function checkCooldown(userId) {
  const until = dbGetCooldown(userId);
  if (!until) return false;
  if (Date.now() < until) return true;
  dbDeleteCooldown(userId);
  return false;
}
async function checkRepeat(userId, message) {
  const now = Date.now();
  const msgLower = message.toLowerCase().trim();
  if (checkCooldown(userId)) return 'cooldown';
  if (!repeatMap.has(userId)) repeatMap.set(userId, { lastMsg: '', count: 0, lastTime: now });
  const data = repeatMap.get(userId);
  if (now - data.lastTime > REPEAT_WINDOW) { data.lastMsg = msgLower; data.count = 1; data.lastTime = now; return 'ok'; }
  if (msgLower === data.lastMsg) {
    data.count++; data.lastTime = now;
    if (data.count >= REPEAT_LIMIT) { data.count = 0; setCooldown(userId); return 'blocked'; }
  } else { data.lastMsg = msgLower; data.count = 1; data.lastTime = now; }
  return 'ok';
}

// ── SYSTEM PROMPTS ──
const SYSTEM_PROMPT_FULL = `Kamu adalah bot AI Discord. Nama kamu adalah AC | BOT AI.

Kepribadian:
- Kalau bahasa Indonesia, selalu pakai "gue" untuk diri sendiri dan "lu" untuk lawan bicara. JANGAN pakai: aku, kamu, saya, anda, kalian, gw
- Aturan kata ganti ini HANYA berlaku untuk bot, bukan untuk user. Jangan pernah koreksi atau tegur user soal kata ganti yang mereka pakai
- Kalau bahasa selain Indonesia (Inggris, dll), DILARANG KERAS pakai "gue", "gw", atau "lu". WAJIB pakai kata ganti bahasa tersebut (Inggris: I/me/you, dll). Ini aturan mutlak yang tidak boleh dilanggar
- Kata "bro" boleh dipakai secara natural tergantung suasana dan konteks percakapan — kalau user santai dan akrab baru pakai, kalau formal atau serius jangan dipaksakan
- Ngomongnya santai dan kasual, tapi tidak alay
- Helpful dan bisa jawab pertanyaan serius
- Pakai emoji secukupnya, tidak berlebihan
- Kalau ada yang toxic atau kasar, tegur dengan santai tapi tegas
- Jawaban to the point, tidak terlalu panjang
- Kalau bahas hal teknis (coding, IT, dll), penjelasannya tetap bener
- Kalau ditanya nama dalam bahasa Indonesia, jawab: nama gue AC | BOT AI. Kalau bahasa lain, sesuaikan (contoh: my name is AC | BOT AI)
- Bisa bantu coding, buatkan script/kode, debug, kasih ide, dan lain-lain
- WAJIB ikuti bahasa yang dipakai user di setiap pesan
- Kamu memiliki pengetahuan luas tentang film, series, anime, dan konten hiburan

Aturan format kode:
- Kalau ada kode/script, WAJIB tulis dalam code block Discord
- Kode Python -> \`\`\`python
- Kode JavaScript -> \`\`\`javascript
- Kode bash/terminal -> \`\`\`bash
- Kode lainnya -> sesuaikan bahasanya
- JANGAN PERNAH tulis kode di luar code block`;

const SYSTEM_PROMPT_LITE = `Kamu adalah bot AI Discord. Nama kamu adalah AC | BOT AI.

Kepribadian:
- Kalau bahasa Indonesia, selalu pakai "gue" untuk diri sendiri dan "lu" untuk lawan bicara. JANGAN pakai: aku, kamu, saya, anda, kalian, gw
- Ngomongnya santai dan kasual, tapi tidak alay
- Helpful dan bisa jawab pertanyaan serius
- Pakai emoji secukupnya, tidak berlebihan
- Jawaban to the point, tidak terlalu panjang
- Kalau ditanya nama dalam bahasa Indonesia, jawab: nama gue AC | BOT AI. Kalau bahasa lain, sesuaikan
- WAJIB ikuti bahasa yang dipakai user di setiap pesan
- Lu HANYA bisa kasih ide, saran, dan ngobrol saja
- JANGAN buatkan kode, script, atau contoh program apapun
- Kalau ada yang minta dibuatkan kode, bilang: "untuk minta dibuatkan kode, coba ketik 'ai' di channel yang support thread ya"`;

// ── DATETIME CONTEXT ──
function getDateTimeContext() {
  const now = new Date();
  const todayStr = now.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
  return `Today is ${todayStr}, ${timeStr} WIB`;
}
function isDateTimeQuestion(msg) {
  const lower = msg.toLowerCase();
  return lower.includes('jam') || lower.includes('tanggal');
}

async function askAI(memoryId, userMessage, fullMode = true, isThread = false) {
  if (GROQ_KEYS.length === 0) throw new Error('Tidak ada Groq API key yang tersedia.');
  const systemPrompt = fullMode ? SYSTEM_PROMPT_FULL : SYSTEM_PROMPT_LITE;
  const history = await getMemory(memoryId);

  if (isDateTimeQuestion(userMessage)) {
    const dtAnswer = `Sekarang ${getDateTimeContext().replace('Today is ', '')} 🕐`;
    addMemoryLocal(memoryId, 'user', userMessage, isThread);
    addMemoryLocal(memoryId, 'assistant', dtAnswer);
    return dtAnswer;
  }

  // Kirim ke Groq DULU, baru simpan ke memory kalau berhasil
  const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];

  let attempts = 0;
  while (attempts < GROQ_KEYS.length) {
    try {
      const completion = await getGroqClient().chat.completions.create({
        model: 'qwen/qwen3-32b', messages, max_tokens: 768, temperature: 0.7,
      });
      const response = completion.choices[0].message.content
  .replace(/<think>[\s\S]*?<\/think>/g, '')
  .trim();
      // Simpan ke memory hanya setelah Groq berhasil reply
      addMemoryLocal(memoryId, 'user', userMessage, isThread);
      addMemoryLocal(memoryId, 'assistant', response);
      return response;
    } catch (err) {
      if (err?.status === 429) {
        console.log(`⚠️ Groq key ${currentGroqIndex + 1} kena rate limit, rotate...`);
        rotateGroqKey();
        attempts++;
      } else {
        console.error('❌ Groq error:', err?.message || err);
        throw err;
      }
    }
  }
  throw new Error('Semua Groq API key kena rate limit!');
}

const voiceConnections = new Map();
async function speakInVoice(guildId, voiceChannel, text) {
  try {
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.slice(0, 200))}&tl=id&client=tw-ob`;
    let vc = voiceConnections.get(guildId);
    if (!vc) {
      const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: voiceChannel.guild.voiceAdapterCreator, selfDeaf: false });
      const player = createAudioPlayer();
      connection.subscribe(player);
      vc = { connection, player };
      voiceConnections.set(guildId, vc);
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        try { connection.destroy(); } catch (_) {}
        voiceConnections.delete(guildId);
      });
    }
    vc.player.play(createAudioResource(ttsUrl));
  } catch (err) { console.error('Voice error:', err); }
}

function buildAIEmbed(answer) {
  const hasCode = answer.includes('```');
  const safeAnswer = answer.length > 4000 ? answer.slice(0, 3997) + '\n...' : answer;
  return new EmbedBuilder().setColor(hasCode ? 0xEB459E : 0x5865F2).setDescription(safeAnswer);
}

async function sendLog(guild, msg, type = 'info') {
  const ch = guild.channels.cache.get(process.env.LOG_CHANNEL_ID);
  if (!ch) return;
  const colors = { info: 0x5865F2, warn: 0xFEE75C, danger: 0xFF0000, success: 0x57F287 };
  const icons = { info: 'ℹ️', warn: '⚠️', danger: '🚨', success: '✅' };
  await ch.send({ embeds: [new EmbedBuilder().setColor(colors[type] || 0x5865F2).setTitle(`${icons[type]} Log`).setDescription(msg).setTimestamp()] }).catch(() => {});
}

// ── SLASH COMMANDS ──
const commands = [
  new SlashCommandBuilder().setName('reset').setDescription('Reset memori percakapan kamu'),
  new SlashCommandBuilder().setName('join').setDescription('Bot masuk voice channel')
    .addChannelOption(o => o.setName('channel').setDescription('Pilih voice channel').addChannelTypes(ChannelType.GuildVoice).setRequired(true)),
  new SlashCommandBuilder().setName('leave').setDescription('Bot keluar dari voice channel'),
  new SlashCommandBuilder().setName('speak').setDescription('Bot bacain teks di voice')
    .addStringOption(o => o.setName('teks').setDescription('Teks yang dibacain').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Voice channel tujuan').addChannelTypes(ChannelType.GuildVoice).setRequired(false)),
  new SlashCommandBuilder().setName('ping').setDescription('Cek latency'),
  new SlashCommandBuilder().setName('help').setDescription('Tampilkan daftar command'),
  new SlashCommandBuilder().setName('addtokenbot').setDescription('[ADMIN] Tambah bot baru ke sistem'),
  new SlashCommandBuilder().setName('announcebot').setDescription('[ADMIN] Kirim pengumuman ke semua server child bot')
    .addStringOption(o => o.setName('pesan').setDescription('Isi pengumuman').setRequired(true)),
  new SlashCommandBuilder().setName('listbot').setDescription('[ADMIN] Lihat semua bot yang terdaftar'),
  new SlashCommandBuilder().setName('removebot').setDescription('[ADMIN] Hapus bot dari sistem')
    .addStringOption(o => o.setName('clientid').setDescription('Client ID bot yang mau dihapus').setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) { console.error('❌ Failed to register commands:', err); }
}

// ── CLIENT READY ──
client.once('clientReady', async () => {
  console.log(`✅ Bot online sebagai ${client.user.tag}`);
  console.log(`🔑 Groq keys loaded: ${GROQ_KEYS.length}`);
  await initDatabase();
  console.log(`🗄️ SQLite database aktif!`);
  await loadAndStartAllBots();
  client.user.setActivity('nge-vibe sama kalian dan King Desu 🔥', { type: 4 });
  await registerCommands();
});

// ── SLASH COMMAND HANDLER ──
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, member, guild, user } = interaction;
    const userId = user.id;

    if (!isAllowedGuild(guild.id)) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('❌ bot ini tidak aktif di server ini.')], flags: MessageFlags.Ephemeral });
    if (!hasPermission(member)) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('❌ kamu ga punya izin 🚫')], flags: MessageFlags.Ephemeral });

  if (commandName === 'help') {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Command List')
        .setDescription('Heyy! Ini semua yang bisa gue lakuin 👇')
        .addFields(
          { name: '💬 Chat AI', value: 'Ketik `ai` di channel → bot buat thread (kalau diizinkan) atau balas langsung', inline: false },
          { name: '🎤 Voice & TTS', value: '`/join <channel>` `/leave` `/speak <teks>`', inline: false },
          { name: '🧠 Memory', value: '`/reset` — hapus memori', inline: false },
          { name: '📊 Info', value: '`/ping` — cek latency', inline: false },
        ).setFooter({ text: 'AC | BOT AI' }).setTimestamp()],
    });
  }

  if (commandName === 'ping') {
    const lat = Date.now() - interaction.createdTimestamp;
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(lat < 100 ? 0x57F287 : lat < 300 ? 0xFEE75C : 0xFF0000).setTitle('🏓 Pong!').addFields({ name: '⏱️ Latency', value: `${lat}ms`, inline: true }, { name: '💻 API', value: `${client.ws.ping}ms`, inline: true }).setTimestamp()] });
  }

  if (commandName === 'reset') {
    await clearMemory(userId);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('✅ memori di-reset! 🧹')], flags: MessageFlags.Ephemeral });
  }

  if (commandName === 'join') {
    const vc = interaction.options.getChannel('channel');
    const connection = joinVoiceChannel({ channelId: vc.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
    const player = createAudioPlayer();
    connection.subscribe(player);
    voiceConnections.set(guild.id, { connection, player });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      try { connection.destroy(); } catch (_) {}
      voiceConnections.delete(guild.id);
    });
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`🎤 masuk ke **${vc.name}**!`)] });
  }

  if (commandName === 'leave') {
    const vc = voiceConnections.get(guild.id);
    if (!vc) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription('gue ga ada di voice 😅')], flags: MessageFlags.Ephemeral });
    vc.connection.destroy();
    voiceConnections.delete(guild.id);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('👋 see ya!')] });
  }

  if (commandName === 'speak') {
    const teks = interaction.options.getString('teks');
    const selectedCh = interaction.options.getChannel('channel');
    const targetCh = selectedCh || member?.voice?.channel;
    if (!targetCh && !voiceConnections.has(guild.id)) {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('pilih voice channel dulu 🎤')], flags: MessageFlags.Ephemeral });
    }
    await speakInVoice(guild.id, targetCh, teks);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription(`🔊 *"${teks.slice(0, 100)}${teks.length > 100 ? '...' : ''}"*`)] });
  }

  if (commandName === 'addtokenbot') {
    if (!isAdminGuild(guild.id) || !isAdminRole(member)) {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('❌ Kamu tidak punya izin untuk command ini.')], flags: MessageFlags.Ephemeral });
    }
    const modal = new ModalBuilder().setCustomId('modal_addbot_1').setTitle('Tambah Bot Baru (1/3)');
    const fields = [
      new TextInputBuilder().setCustomId('token').setLabel('Token Bot').setStyle(TextInputStyle.Short).setRequired(true),
      new TextInputBuilder().setCustomId('clientId').setLabel('Client ID').setStyle(TextInputStyle.Short).setRequired(true),
      new TextInputBuilder().setCustomId('groqKeys').setLabel('Groq API Key (pisah koma, maks 3)').setStyle(TextInputStyle.Paragraph).setRequired(true),
      new TextInputBuilder().setCustomId('botInfo').setLabel('Deskripsi Bot (opsional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('cth: Bot untuk server gaming'),
    ];
    fields.forEach(f => modal.addComponents(new ActionRowBuilder().addComponents(f)));
    return interaction.showModal(modal);
  }

  if (commandName === 'announcebot') {
    if (!isAdminGuild(guild.id) || !isAdminRole(member)) {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('❌ Kamu tidak punya izin untuk command ini.')], flags: MessageFlags.Ephemeral });
    }
    const pesan = interaction.options.getString('pesan');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await announceToAllBots(pesan);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('✅ Pengumuman berhasil dikirim ke semua server child bot!')] });
  }

  if (commandName === 'listbot') {
    if (!isAdminGuild(guild.id) || !isAdminRole(member)) {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('❌ Kamu tidak punya izin.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const bots = dbGetAllBots();
    if (bots.length === 0) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription('Belum ada bot yang terdaftar.')] });

    const now = new Date();
    const desc = bots.map((b, i) => {
      const expired = now > b.expireAt;
      const running = getRunningBots().has(b.token);
      const status = expired ? '🔴 Expired' : running ? '🟢 Online' : '🟡 Offline';
      return `**${i + 1}. ${b.aiName}**\nClient ID: \`${b.clientId}\`\nStatus: ${status}\nMasa Aktif: ${b.expireAt.toLocaleDateString('id-ID')}`;
    }).join('\n\n');

    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`🤖 Daftar Bot (${bots.length})`).setDescription(desc).setTimestamp()] });
  }

  if (commandName === 'removebot') {
    if (!isAdminGuild(guild.id) || !isAdminRole(member)) {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('❌ Kamu tidak punya izin.')], flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targetClientId = interaction.options.getString('clientid').trim();
    const cfg = dbGetBotByClientId(targetClientId);
    if (!cfg) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription(`❌ Bot dengan Client ID \`${targetClientId}\` tidak ditemukan.`)] });

    const { stopChildBot } = require('./botManager');
    await stopChildBot(cfg.token);
    dbDeleteBot(targetClientId);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ Bot \`${cfg.aiName}\` (${targetClientId}) berhasil dihapus dan diofflinekan.`)] });
  }
  } catch (err) {
    console.error('❌ Unhandled slash command error:', err?.message || err);
    try {
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Terjadi error, coba lagi.', flags: MessageFlags.Ephemeral });
    } catch (_) {}
  }
});

// ── TEMP STORAGE antar modal step (auto-expire 5 menit) ──
const addBotTemp = new Map();
function setAddBotTemp(userId, data) {
  // Hapus timer lama kalau ada
  const existing = addBotTemp.get(userId);
  if (existing?.expireTimer) clearTimeout(existing.expireTimer);
  // Auto-hapus setelah 5 menit kalau tidak diselesaikan
  const expireTimer = setTimeout(() => {
    addBotTemp.delete(userId);
    console.log(`⏰ addBotTemp expired untuk user ${userId}`);
  }, 10 * 60 * 1000);
  addBotTemp.set(userId, { ...data, expireTimer });
}
function getAddBotTemp(userId) {
  return addBotTemp.get(userId);
}
function deleteAddBotTemp(userId) {
  const existing = addBotTemp.get(userId);
  if (existing?.expireTimer) clearTimeout(existing.expireTimer);
  addBotTemp.delete(userId);
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isModalSubmit() && interaction.customId === 'modal_addbot_1') {
    if (!isAdminGuild(interaction.guild.id) || !isAdminRole(interaction.member))
      return interaction.reply({ content: '❌ Tidak punya izin.', flags: MessageFlags.Ephemeral });
    const token    = interaction.fields.getTextInputValue('token').trim();
    const clientId = interaction.fields.getTextInputValue('clientId').trim();
    const groqKeys = interaction.fields.getTextInputValue('groqKeys').trim().split(',').map(k => k.trim()).filter(Boolean).slice(0, 3);
    setAddBotTemp(interaction.user.id, { token, clientId, groqKeys });
    const btn = new ButtonBuilder().setCustomId('addbot_next_2').setLabel('Next → (2/3)').setStyle(ButtonStyle.Primary);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('✅ Step 1 tersimpan! Klik **Next** untuk lanjut ke konfigurasi channel & role.')],
      components: [new ActionRowBuilder().addComponents(btn)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.isButton() && interaction.customId === 'addbot_next_2') {
    if (!isAdminGuild(interaction.guild.id) || !isAdminRole(interaction.member))
      return interaction.reply({ content: '❌ Tidak punya izin.', flags: MessageFlags.Ephemeral });
    if (!getAddBotTemp(interaction.user.id))
      return interaction.reply({ content: '❌ Session expired. Ulangi /addtokenbot.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId('modal_addbot_2').setTitle('Tambah Bot Baru (2/3)');
    const fields = [
      new TextInputBuilder().setCustomId('logChannelId').setLabel('Log Channel ID').setStyle(TextInputStyle.Short).setRequired(false),
      new TextInputBuilder().setCustomId('threadChannelIds').setLabel('Thread Channel IDs (pisah koma)').setStyle(TextInputStyle.Short).setRequired(false),
      new TextInputBuilder().setCustomId('allowedRoles').setLabel('Allowed Role IDs (pisah koma)').setStyle(TextInputStyle.Short).setRequired(false),
      new TextInputBuilder().setCustomId('allowedGuilds').setLabel('Allowed Guild IDs (pisah koma)').setStyle(TextInputStyle.Short).setRequired(false),
    ];
    fields.forEach(f => modal.addComponents(new ActionRowBuilder().addComponents(f)));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'modal_addbot_2') {
    if (!isAdminGuild(interaction.guild.id) || !isAdminRole(interaction.member))
      return interaction.reply({ content: '❌ Tidak punya izin.', flags: MessageFlags.Ephemeral });
    const temp = getAddBotTemp(interaction.user.id);
    if (!temp) return interaction.reply({ content: '❌ Session expired. Ulangi /addtokenbot.', flags: MessageFlags.Ephemeral });
    temp.logChannelId     = interaction.fields.getTextInputValue('logChannelId').trim();
    temp.threadChannelIds = interaction.fields.getTextInputValue('threadChannelIds').trim();
    temp.allowedRoles     = interaction.fields.getTextInputValue('allowedRoles').trim();
    temp.allowedGuilds    = interaction.fields.getTextInputValue('allowedGuilds').trim();
    const btn = new ButtonBuilder().setCustomId('addbot_next_3').setLabel('Next → (3/3)').setStyle(ButtonStyle.Primary);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('✅ Step 2 tersimpan! Klik **Next** untuk lanjut ke masa aktif & nama bot.')],
      components: [new ActionRowBuilder().addComponents(btn)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.isButton() && interaction.customId === 'addbot_next_3') {
    if (!isAdminGuild(interaction.guild.id) || !isAdminRole(interaction.member))
      return interaction.reply({ content: '❌ Tidak punya izin.', flags: MessageFlags.Ephemeral });
    if (!getAddBotTemp(interaction.user.id))
      return interaction.reply({ content: '❌ Session expired. Ulangi /addtokenbot.', flags: MessageFlags.Ephemeral });
    const modal = new ModalBuilder().setCustomId('modal_addbot_3').setTitle('Tambah Bot Baru (3/3)');
    const fields = [
      new TextInputBuilder().setCustomId('expireDays').setLabel('Masa Aktif (hari)').setStyle(TextInputStyle.Short).setPlaceholder('30').setRequired(true),
      new TextInputBuilder().setCustomId('aiName').setLabel('Nama Custom AI Bot').setStyle(TextInputStyle.Short).setPlaceholder('AC | BOT AI').setRequired(false),
      new TextInputBuilder().setCustomId('enableVoice').setLabel('Aktifkan Voice? (ya/tidak)').setStyle(TextInputStyle.Short).setPlaceholder('tidak').setRequired(false),
      new TextInputBuilder().setCustomId('voiceRoles').setLabel('Voice Role IDs (pisah koma)').setStyle(TextInputStyle.Short).setPlaceholder('Kosong = semua bisa').setRequired(false),
    ];
    fields.forEach(f => modal.addComponents(new ActionRowBuilder().addComponents(f)));
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'modal_addbot_3') {
    if (!isAdminGuild(interaction.guild.id) || !isAdminRole(interaction.member))
      return interaction.reply({ content: '❌ Tidak punya izin.', flags: MessageFlags.Ephemeral });
    const temp = getAddBotTemp(interaction.user.id);
    if (!temp) return interaction.reply({ content: '❌ Session expired. Ulangi /addtokenbot.', flags: MessageFlags.Ephemeral });
    try {
      const expireDays  = parseInt(interaction.fields.getTextInputValue('expireDays').trim()) || 30;
      const aiName      = interaction.fields.getTextInputValue('aiName').trim() || 'AC | BOT AI';
      const enableVoice = interaction.fields.getTextInputValue('enableVoice').trim().toLowerCase() === 'ya';
      const voiceRoles  = interaction.fields.getTextInputValue('voiceRoles').trim();
      const expireAt    = new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000);

      const existing = dbGetBotByToken(temp.token);
      if (existing) {
        deleteAddBotTemp(interaction.user.id);
        return interaction.reply({ content: '❌ Token bot ini sudah terdaftar.', flags: MessageFlags.Ephemeral });
      }

      const cfg = dbInsertBot({
        token: temp.token, clientId: temp.clientId, groqKeys: temp.groqKeys,
        logChannelId: temp.logChannelId || '', threadChannelIds: temp.threadChannelIds || '',
        allowedRoles: temp.allowedRoles || '', allowedGuilds: temp.allowedGuilds || '',
        expireAt, aiName, enableVoice, voiceRoles,
      });

      deleteAddBotTemp(interaction.user.id);
      await startChildBot(cfg);

      const embed = new EmbedBuilder()
        .setColor(0x57F287).setTitle('✅ Bot Berhasil Ditambahkan!')
        .addFields(
          { name: 'Client ID', value: temp.clientId, inline: true },
          { name: 'AI Name', value: aiName, inline: true },
          { name: 'Groq Keys', value: `${temp.groqKeys.length} key`, inline: true },
          { name: 'Log Channel', value: temp.logChannelId || '-', inline: true },
          { name: 'Allowed Guilds', value: temp.allowedGuilds || 'Semua', inline: true },
          { name: 'Voice', value: enableVoice ? `✅ Aktif${voiceRoles ? ` (${voiceRoles})` : ' (semua)'}` : '❌ Nonaktif', inline: true },
          { name: 'Masa Aktif', value: `${expireDays} hari (sampai ${expireAt.toLocaleDateString('id-ID')})`, inline: false },
        ).setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('❌ addtokenbot error:', err?.message || err);
      deleteAddBotTemp(interaction.user.id);
      return interaction.reply({ content: `❌ Gagal menambahkan bot: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
  }
  } catch (err) {
    console.error('❌ Unhandled modal/button error:', err?.message || err);
    try {
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: '❌ Terjadi error, coba lagi.', flags: MessageFlags.Ephemeral });
    } catch (_) {}
  }
});

// ── VOICE STATE UPDATE ──
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (newState.id !== client.user.id) return;
  if (oldState.channelId && !newState.channelId) {
    const isManualLeave = !voiceConnections.has(oldState.guild.id);
    const vc = voiceConnections.get(oldState.guild.id);
    if (vc) {
      try { vc.connection.destroy(); } catch (_) {}
      voiceConnections.delete(oldState.guild.id);
    }
    if (!isManualLeave) {
      let kickerInfo = 'Unknown';
      try {
        await new Promise(r => setTimeout(r, 1500));
        const auditLogs = await oldState.guild.fetchAuditLogs({ type: 74, limit: 10 });
        console.log('[VoiceKick Debug] Total entries:', auditLogs.entries.size);
        console.log('[VoiceKick Debug] Bot ID:', client.user.id);
        auditLogs.entries.forEach(e => {
          console.log('[VoiceKick Debug] entry — executor:', e.executor?.tag, 'target:', e.target?.id, 'age:', (Date.now() - e.createdTimestamp) + 'ms');
        });
        const entry = auditLogs.entries.find(e =>
          Date.now() - e.createdTimestamp < 8000 &&
          e.target?.id === client.user.id
        );
        console.log('[VoiceKick Debug] Matching entry found:', !!entry);
        if (entry) {
          const executor = entry.executor ?? await oldState.guild.members.fetch(entry.executorId).catch(() => null);
          if (executor) {
            const tag = executor.tag ?? executor.user?.tag ?? `<@${executor.id ?? entry.executorId}>`;
            const id  = executor.id ?? entry.executorId;
            kickerInfo = `${tag} (<@${id}>)`;
          }
        }
      } catch (err) {
        console.error('[VoiceKick Debug] Error:', err.message);
      }
      await sendLog(oldState.guild, `**🎤 Bot Di-kick dari Voice**\n📢 Channel: **${oldState.channel?.name || 'Unknown'}**\n👤 Oleh: ${kickerInfo}`, 'warn');
    }
  }
});

// ── MESSAGE HANDLER ──
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    const userId = message.author.id;
    const content = message.content.trim();
    if (!isAllowedGuild(message.guild.id)) return;
    const contentLower = content.toLowerCase();
    const isThread = message.channel.isThread();

    // Abaikan @everyone / @here kecuali bot di-tag langsung via <@ID>
    if (/@everyone|@here/.test(content)) {
      if (!new RegExp(`<@!?${client.user.id}>`).test(content)) return;
    }

  const repeat = await checkRepeat(userId, content);
  if (repeat === 'blocked') {
    await sendLog(message.guild, `**🔁 Pesan Berulang**\n👤 User: ${message.author.tag} (<@${userId}>)\n📌 Channel: <#${message.channel.id}>\n⏱️ Timeout Discord: 2 jam | Bot cooldown: 24 jam`, 'danger');
    try {
      await message.member.timeout(REPEAT_TIMEOUT, 'Auto-timeout: pesan berulang ke bot');
      await message.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription(`<@${userId}> kamu kena timeout **2 jam** dan bot tidak akan merespon kamu selama **24 jam** karena mengirim pesan yang sama berulang kali 🚫`)] }).catch(() => {});
      await message.author.send({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('🚨 Kamu di-timeout').setDescription('Kamu di-timeout **2 jam** dan bot tidak akan merespon kamu selama **24 jam** karena mengirim pesan yang sama berulang kali.').setTimestamp()] }).catch(() => {});
    } catch (err) { console.error('Repeat timeout error:', err); }
    return;
  }

  const triggerWord = TRIGGER_WORDS.find(w => contentLower === w || contentLower.startsWith(w + ' '));
  const isTrigger = !!triggerWord;
  const isForumThread = isThread && message.channel.parent?.type === ChannelType.GuildForum;
  const isReplyToBot = message.reference && (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user.id;

  if (isReplyToBot && !isForumThread) {
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 5000);
    message.channel.sendTyping().catch(() => {});
    const threadMessages = isThread ? await getMemory(message.channel.id) : [];
    const fullMode = isThread && threadMessages.length > 0;
    try {
      const memId = isThread ? message.channel.id : userId;
      const reply = await askAI(memId, content, fullMode, isThread);
      clearInterval(typingInterval);
      await message.reply({ embeds: [buildAIEmbed(reply)] });
    } catch (err) { clearInterval(typingInterval); console.error('Reply AI error:', err); }
    return;
  }

  const threadMessages = isThread ? await getMemory(message.channel.id) : [];
  if (isThread && threadMessages.length > 0) {
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 5000);
    message.channel.sendTyping().catch(() => {});
    try {
      const reply = await askAI(message.channel.id, content, true, true);
      clearInterval(typingInterval);
      await message.reply({ embeds: [buildAIEmbed(reply)] });
    } catch (err) {
      clearInterval(typingInterval);
      console.error('AI error:', err);
      await message.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('error 😭 coba lagi ya')] });
    }
    return;
  }

  if (isThread && message.channel.parent?.type === ChannelType.GuildForum) {
    const isMentioned = message.mentions.has(client.user);
    if (!isTrigger && !isMentioned) return;
    const userMsg = isMentioned
      ? (content.replace(/<@!?\d+>/g, '').trim() || 'Halo! Ada yang bisa gue bantu?')
      : content.slice(triggerWord.length).trim() || 'Halo!';
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 5000);
    message.channel.sendTyping().catch(() => {});
    try {
      const reply = await askAI(userId, userMsg, false);
      clearInterval(typingInterval);
      await message.reply({ embeds: [buildAIEmbed(reply)] });
    } catch (err) {
      clearInterval(typingInterval);
      console.error('Forum AI error:', err);
      await message.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('error 😭 coba lagi ya')] });
    }
    return;
  }

  const isMentionedMain = message.mentions.has(client.user);
  if (!isThread && (isTrigger || isMentionedMain)) {
    const userMsg = isMentionedMain
      ? (content.replace(/<@!?\d+>/g, '').trim() || 'Halo! Ada yang bisa gue bantu?')
      : (triggerWord ? content.slice(triggerWord.length).trim() : content.trim()) || 'Halo!';
    const canThread = [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(message.channel.type);
    const threadAllowed = isThreadAllowed(message.channel.id);
    if (canThread && threadAllowed) {
      try {
        const thread = await message.startThread({ name: `Chat: ${message.author.username}`, autoArchiveDuration: 60 });
        const typingInterval = setInterval(() => thread.sendTyping().catch(() => {}), 5000);
        thread.sendTyping().catch(() => {});
        const firstMsg = userMsg || 'Halo, perkenalkan dirimu singkat dan tanya apa yang bisa dibantu.';
        const reply = await askAI(thread.id, firstMsg, true, true);
        clearInterval(typingInterval);
        await thread.send({ embeds: [buildAIEmbed(reply)] });
      } catch (err) {
        console.error('Thread error:', err);
        try {
          message.channel.sendTyping().catch(() => {});
          const reply = await askAI(userId, userMsg || 'Halo! Ada yang bisa gue bantu?', false);
          await message.reply({ embeds: [buildAIEmbed(reply)] });
        } catch (e) { console.error('AI error:', e); }
      }
    } else {
      const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 5000);
      message.channel.sendTyping().catch(() => {});
      try {
        const reply = await askAI(userId, userMsg || 'Halo!', false);
        clearInterval(typingInterval);
        await message.reply({ embeds: [buildAIEmbed(reply)] });
      } catch (err) {
        clearInterval(typingInterval);
        console.error('❌ AI error:', err?.message || err);
        await message.reply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('error 😭 coba lagi ya')] }).catch(() => {});
      }
    }
    return;
  }
  } catch (err) {
    console.error('❌ Unhandled messageCreate error:', err?.message || err);
  }
});

// ── GLOBAL ERROR HANDLER ──
process.on('unhandledRejection', (err) => { console.error('⚠️ Unhandled Rejection:', err?.message || err); });
process.on('uncaughtException', (err) => { console.error('⚠️ Uncaught Exception:', err?.message || err); });
client.on('error', (err) => { console.error('⚠️ Discord client error:', err?.message || err); });

// ── LOGIN ──
client.login(process.env.DISCORD_TOKEN);