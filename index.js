require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { Player, QueryType } = require('discord-player');
const fs = require('fs');
const path = require('path');

// Parse cookie dari cookies.txt
let cookieStr = '';
try {
  const cookiePath = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookiePath)) {
    const lines = fs.readFileSync(cookiePath, 'utf8').split('\n');
    cookieStr = lines
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        const parts = l.split('\t');
        if (parts.length >= 7) return `${parts[5].trim()}=${parts[6].trim()}`;
        return null;
      })
      .filter(Boolean)
      .join('; ');
    if (cookieStr) console.log('🍪 Cookie YouTube dimuat.');
  }
} catch (e) {
  console.warn('⚠️ Cookie gagal dimuat:', e.message);
}

const ytdl = require('@distube/ytdl-core');
const agent = cookieStr ? ytdl.createAgent(
  cookieStr.split('; ').map(c => {
    const [name, ...rest] = c.split('=');
    return { name: name.trim(), value: rest.join('=').trim(), domain: '.youtube.com' };
  })
) : undefined;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const player = new Player(client, {
  skipFFmpeg: false,
});

(async () => {
  try {
    await player.extractors.loadDefault((ext) => ext !== 'YoutubeExtractor');
    console.log('✅ Extractor dimuat (tanpa YoutubeExtractor).');
  } catch (err) {
    console.warn('⚠️ Extractor gagal:', err.message);
  }
})();

client.player = player;
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.name, command);
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const prefix = process.env.PREFIX || '!';
  if (!message.content.startsWith(prefix)) return;
  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();
  const command = client.commands.get(commandName);
  if (!command) return;
  try {
    await command.execute(message, args, client);
  } catch (err) {
    console.error(err);
    message.reply('❌ Terjadi error saat menjalankan perintah.');
  }
});

player.events.on('playerStart', (queue, track) => {
  queue.metadata.channel.send(`▶️ Sekarang memutar: **${track.title}** oleh **${track.author}**`);
});
player.events.on('audioTrackAdd', (queue, track) => {
  queue.metadata.channel.send(`✅ Ditambahkan ke antrian: **${track.title}**`);
});
player.events.on('disconnect', (queue) => {
  queue.metadata.channel.send('👋 Bot keluar dari voice channel.');
});
player.events.on('emptyQueue', (queue) => {
  queue.metadata.channel.send('✅ Antrian habis. Sampai jumpa!');
});
player.events.on('error', (queue, error) => {
  console.error(`Player error: ${error.message}`);
  queue.metadata?.channel?.send(`❌ Error: ${error.message}`);
});
player.events.on('playerError', (queue, error) => {
  console.error(`Player error: ${error.message}`);
  queue.metadata?.channel?.send(`❌ Error saat memutar: ${error.message}`);
});

// Handle YouTube streaming via ytdl dengan cookie
player.on('debug', (message) => {
  if (message.includes('stream')) console.log('[DEBUG]', message);
});

// Patch nodes.create untuk inject onBeforeCreateStream
const _create = player.nodes.create.bind(player.nodes);
player.nodes.create = (guild, options = {}) => {
  if (!options.onBeforeCreateStream) {
    options.onBeforeCreateStream = async (track, queryType) => {
      const isYT = track.url?.includes('youtube.com') || track.url?.includes('youtu.be');
      if (isYT) {
        try {
          console.log(`🎵 ytdl stream: ${track.url}`);
          return ytdl(track.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25,
            agent,
          });
        } catch (e) {
          console.warn('⚠️ ytdl gagal:', e.message);
        }
      }
      return null;
    };
  }
  return _create(guild, options);
};

client.once('ready', () => {
  console.log(`✅ Bot siap! Login sebagai ${client.user.tag}`);
});

client.login(process.env.TOKEN);
