# List Domain Expired Otomatis (Bung Huda Web Tools)

Daftar domain expired yang diperbarui otomatis setiap hari, gratis, tanpa server.

**Cara kerja:** setiap hari pukul 23:30 WIB, GitHub Actions menjalankan `scripts/update.mjs`. Skrip ini:
1. mengunduh file inventaris lelang domain expiring dari GoDaddy Auctions (publik, tanpa login, diperbarui GoDaddy setiap hari),
2. menyaring domain (membuang yang mengandung tanda hubung, terlalu banyak angka, terlalu panjang, atau konten dewasa),
3. membuang domain yang sudah pernah tampil dalam 45 hari terakhir, jadi yang masuk hanya domain baru,
4. mengurutkan berdasarkan umur, traffic, nilai taksiran, dan jumlah bid, lalu menyimpan maksimal 1.500 domain per hari,
5. menyimpan hasilnya ke folder `data/`. Halaman Blogger membaca folder ini.

## Pemasangan (sekali saja, ±10 menit)

### 1. Buat repo GitHub
1. Login ke github.com, lalu klik **New repository**. Beri nama misalnya `domain-expired-bot` dan pilih **Public** (wajib supaya Blogger bisa membaca datanya).
2. Unggah semua isi folder ini (`scripts/`, `.github/`, `README.md`) lewat **Add file → Upload files**.
   > Folder `.github` kadang tidak ikut saat di-drag. Kalau begitu, buat filenya manual: **Add file → Create new file**, isi nama `.github/workflows/update.yml`, lalu tempel isi file tersebut.

### 2. Izinkan Actions menulis ke repo
Buka **Settings → Actions → General → Workflow permissions**, pilih **Read and write permissions**, lalu klik Save.

### 3. Jalankan pertama kali
Buka tab **Actions → Update domain expired harian → Run workflow**. Tunggu 1–3 menit sampai centangnya hijau. Setelah itu folder `data/` akan muncul di repo.
Selanjutnya workflow berjalan sendiri setiap hari.

### 4. Pasang di Blogger
1. Buka `blogger/list-domain-expired.html`, lalu isi `DATA_BASE` di bagian KONFIGURASI:
   ```
   DATA_BASE: "https://raw.githubusercontent.com/USERNAME/domain-expired-bot/main/data/",
   ```
   Ganti `USERNAME` dengan nama akun GitHub Anda.
2. Di Blogger, pilih **Laman → Laman baru**, pindah ke **tampilan HTML**, tempel seluruh isi file, lalu Publikasikan.

## Pengaturan opsional
Ubah di `.github/workflows/update.yml`, bagian `env:` (hapus tanda `#` di depannya):

| Variabel | Default | Fungsi |
|---|---|---|
| `MAX_PER_DAY` | 1500 | jumlah domain baru maksimal per hari |
| `MIN_AGE` | 1 | umur domain minimal (tahun) |
| `TLDS` | semua | contoh `.com,.net,.org`, untuk membatasi TLD |
| `FILE_PATTERNS` | `expir` | pola nama file inventaris GoDaddy yang diambil |
| `KEEP_DAYS` | 365 | data harian yang lebih lama dari ini dihapus (arsip bulanan tetap tercatat) |

**Open PageRank (pengganti DA, opsional):** daftar API key di keywordseverywhere.com/openpagerank, lalu simpan di **Settings → Secrets and variables → Actions → New secret** dengan nama `OPR_KEY`. Kolom OPR akan muncul otomatis di halaman.
> Catatan: sejak November 2026, key gratis Open PageRank hanya bisa dipakai dari satu alamat IP. Alamat IP GitHub Actions berganti-ganti, jadi fitur ini butuh paket berbayar. Tanpa key, tool tetap berjalan normal (memakai umur, bid, traffic, dan nilai).

## Kalau workflow gagal
Buka log di tab Actions. Skrip mencetak daftar file yang tersedia di GoDaddy dan kolom yang terdeteksi.
- **"Tidak ada file yang cocok"**: GoDaddy mengganti nama file. Atur `FILE_PATTERNS` sesuai nama file di log.
- **"Kolom nama domain tidak ditemukan"**: format file berubah. Kolom yang tersedia ikut tercetak di log.

GitHub menonaktifkan jadwal workflow jika repo tidak aktif selama 60 hari. Karena bot melakukan commit setiap hari, repo tetap dianggap aktif. Kalau suatu saat jadwalnya berhenti, klik **Enable workflow** di tab Actions.
