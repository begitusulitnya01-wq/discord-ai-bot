const { useMainPlayer, QueryType } = require('discord-player');

module.exports = {
  name: 'play',
  description: 'Putar musik dari YouTube, Spotify, SoundCloud, atau URL langsung',
  async execute(message, args, client) {
    if (!args.length) {
      return message.reply('❌ Harap masukkan nama lagu atau URL.\nContoh: `!play Never Gonna Give You Up`');
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('❌ Kamu harus berada di voice channel terlebih dahulu!');
    }

    const botMember = message.guild.members.cache.get(client.user.id);
    const permissions = voiceChannel.permissionsFor(botMember);
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
      return message.reply('❌ Bot tidak memiliki izin untuk masuk atau berbicara di voice channel tersebut!');
    }

    const query = args.join(' ');
    const player = useMainPlayer();

    // Deteksi apakah query adalah URL atau teks biasa
    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    const queryType = isUrl ? QueryType.AUTO : QueryType.YOUTUBE_SEARCH;

    try {
      const { track } = await player.play(voiceChannel, query, {
        searchEngine: queryType,
        nodeOptions: {
          metadata: {
            channel: message.channel,
          },
        },
      });
    } catch (err) {
      console.error(err);
      message.reply(`❌ Tidak dapat memutar lagu: \`${err.message}\``);
    }
  },
};
