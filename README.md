# 🎵 Discord Music Bot

Bot Discord untuk memutar musik dari YouTube, Spotify, SoundCloud, dan URL langsung.

---

## 📦 Fitur
- ▶️ Play / Pause / Resume / Stop
- ⏭️ Skip lagu
- 📋 Queue (antrian lagu)
- 🎵 Now Playing dengan progress bar
- 🔗 Dukungan: YouTube, Spotify, SoundCloud, URL langsung

---

## ⚙️ Cara Setup

### 1. Install Node.js
Pastikan Node.js versi **18 ke atas** sudah terinstall.

### 2. Clone / Download project ini
```bash
cd discord-music-bot
```

### 3. Install dependencies
```bash
npm install
```

### 4. Buat file .env
```bash
cp .env.example .env
```
Lalu edit file `.env` dan isi `TOKEN` dengan token bot Discord kamu.

> 💡 Cara dapat token bot:
> 1. Buka https://discord.com/developers/applications
> 2. Buat aplikasi baru → bagian "Bot" → klik "Reset Token"
> 3. Copy token tersebut ke file `.env`

### 5. Aktifkan Privileged Intents
Di dashboard Discord Developer:
- Buka bagian **Bot**
- Aktifkan: **Message Content Intent** dan **Server Members Intent**

### 6. Invite bot ke server
Di bagian **OAuth2 > URL Generator**, pilih:
- Scopes: `bot`
- Permissions: `Connect`, `Speak`, `Send Messages`, `Read Message History`, `Use Embedded Activities`

### 7. Jalankan bot
```bash
npm start
```

---

## 🎮 Daftar Perintah

| Perintah | Deskripsi |
|---|---|
| `!play <judul/url>` | Putar lagu atau tambah ke antrian |
| `!pause` | Jeda musik |
| `!resume` | Lanjutkan musik |
| `!stop` | Hentikan musik & kosongkan antrian |
| `!skip` | Lewati lagu saat ini |
| `!queue` / `!q` | Lihat antrian lagu |
| `!nowplaying` / `!np` | Lagu yang sedang diputar |
| `!help` | Tampilkan semua perintah |

---

## ☁️ Deploy ke Wispbyte

1. Upload semua file ke Wispbyte
2. Pastikan **Start Command** diset ke: `node index.js`
3. Isi environment variable `TOKEN` dan `PREFIX` di panel Wispbyte
4. Jalankan bot!

> ⚠️ Jangan upload file `.env` ke hosting, gunakan panel environment variables dari Wispbyte.

---

## 🔧 Troubleshooting

- **"Cannot find module ffmpeg"** → Jalankan `npm install ffmpeg-static`
- **Bot tidak merespon** → Pastikan **Message Content Intent** sudah diaktifkan
- **Spotify tidak berfungsi** → Isi `SPOTIFY_CLIENT_ID` dan `SPOTIFY_CLIENT_SECRET` di `.env`
