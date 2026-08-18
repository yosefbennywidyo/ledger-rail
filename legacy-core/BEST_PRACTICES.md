# COBOL / GnuCOBOL — Best Practices untuk `legacy-core`

> Diringkas dari dokumentasi resmi GnuCOBOL Programmer's Guide dan FAQ
> (gnucobol.sourceforge.io), diakses 2026-08-18, sebelum program batch ini
> ditulis.

## Catatan tentang ketersediaan materi

GnuCOBOL adalah proyek niche — pencarian web untuk "best practice 2026"
tidak menghasilkan materi baru yang spesifik tahun ini; hasil pencarian
mengarah balik ke dokumentasi resmi yang sudah stabil selama bertahun-tahun
(GnuCOBOL Programmer's Guide, FAQ, dan tulisan komunitas tahun 2020-an).
Ini diharapkan: konvensi COBOL (struktur empat DIVISION, copybook untuk
record layout) sudah baku sejak standar COBOL asli dan tidak banyak
berubah — jadi dokumen ini memakai konvensi COBOL klasik yang
didokumentasikan resmi, bukan "best practice 2026" yang direka-reka.

## Sumber yang benar-benar dicek

- [GnuCOBOL Programmer's Guide](https://gnucobol.sourceforge.io/HTML/gnucobpg.html) —
  konfirmasi bahwa **free-format source** didukung penuh di GnuCOBOL modern
  (program-text area mulai kolom 1, tanpa batasan Area A/B ala kartu punch),
  dan bahwa **copybook** adalah cara standar mendeskripsikan record layout
  file supaya beberapa program yang membaca file yang sama melihat layout
  yang identik (`COPY "nama-file.cpy"`).
- [GnuCOBOL FAQ and How To](https://gnucobol.sourceforge.io/faq/index.html) —
  konfirmasi mekanisme pencarian copybook lewat opsi compiler `-I` atau
  environment variable `COB_COPY_DIR`.
- [Intermediate COBOL — Chapter 9: Copybooks and Code Reuse](https://datafield.dev/intermediate-cobol/part-02/chapter-09/) —
  konfirmasi pola umum: FD diikuti `COPY` statement yang mengembang jadi
  01-level record description, dan best practice memisahkan record layout
  ke file `.cpy` terpisah alih-alih menulis ulang di setiap program yang
  butuh format file yang sama.
- [Paul Smith — "COBOL, GnuCOBOL, and Go"](https://smith.dev/2020/04/22/cobol-gnucobol-and-go-part-1/) —
  konfirmasi pola umum industri: data COBOL cenderung fixed-width, dan
  offset/panjang tiap field diketahui lewat definisi copybook — pola yang
  sama dipakai proyek ini untuk `data/transactions.dat` dan
  `data/balances.dat`.

## Keputusan dialek: free-format, bukan fixed-format

GnuCOBOL mendukung dua gaya penulisan source:

- **Fixed-format** (default `cobc`): warisan kartu punch 80-kolom — kolom
  1-6 area nomor urut, kolom 7 area indikator (`*` untuk komentar), Area A
  mulai kolom 8, Area B mulai kolom 12. Ini gaya paling "otentik" untuk
  ilustrasi mainframe lawas.
- **Free-format** (`cobc -free` atau `>>SOURCE FREE`): teks program mulai
  kolom 1, komentar pakai `*>`, tanpa batas kolom kaku (praktis sampai 255
  karakter/baris).

**Proyek ini memilih free-format**, dengan pertimbangan:

1. Ini eksplisit didukung resmi di GnuCOBOL 3.x sebagai gaya penulisan
   modern — bukan hack, bukan penyimpangan dari standar.
2. Batasan kolom fixed-format (Area A/B) adalah sumber kesalahan yang
   sangat mudah terjadi tanpa editor COBOL khusus (mis. statement yang
   tanpa sengaja mulai di kolom 8 padahal harusnya di Area B, atau baris
   yang melewati kolom 72 lalu terpotong diam-diam) — risiko yang tidak
   sepadan untuk proyek ilustrasi portofolio ini.
3. Contoh command yang diberikan di `project-requirements.md` sendiri
   memakai `-free` sebagai opsi utama.

Trade-off yang disadari: fixed-format lebih "period-accurate" untuk
nuansa mainframe tahun 1970-80an. Kalau proyek ini nanti ingin
menambahkan nuansa itu, source free-format tetap bisa dikonversi manual
tanpa mengubah logic — hanya masalah spasi/kolom.

## Struktur folder

```
legacy-core/
  eod-settlement.cbl         # program batch utama
  copybooks/
    transaction-record.cpy   # layout data/transactions.dat
    opening-balance-record.cpy  # layout data/opening-balances.dat
  data/
    transactions.dat         # input harian (fixed-width)
    opening-balances.dat     # input opsional (fixed-width)
    balances.dat             # output laporan saldo (dihasilkan program)
    errors.log               # log baris yang di-skip (dihasilkan program)
  BEST_PRACTICES.md
  README.md
```

**Kenapa copybook terpisah:** mengikuti best practice standar COBOL —
layout record disimpan sekali di `copybooks/*.cpy` dan di-`COPY` ke dalam
`FD` di `eod-settlement.cbl`. Kalau nanti ditambah program COBOL kedua
yang membaca `transactions.dat` yang sama (mis. validator terpisah),
program itu cukup `COPY` file yang sama — layout tidak pernah bisa
"menyimpang" antara dua program karena sumbernya satu file.

## Konvensi lain yang dipegang di program ini

- **FILE STATUS di setiap SELECT** — setiap file punya field
  `FILE STATUS IS WS-...-STATUS` sendiri, dicek setelah `OPEN` dan (via
  `AT END`) setelah `READ`. Ini pengganti exception handling di COBOL:
  tanpa ini, error I/O (file tidak ada, disk penuh, dll) bisa membuat
  program lanjut jalan dengan data yang salah tanpa pemberitahuan.
- **Inisialisasi record ke SPACES sebelum WRITE** — sebelum mengisi field
  `BALANCE-REPORT-RECORD`, program melakukan `MOVE SPACES TO
  BALANCE-REPORT-RECORD` dulu. Ditemukan lewat trial-and-error saat
  verifikasi (lihat bagian verifikasi di README): tanpa ini, GnuCOBOL
  runtime sempat menolak WRITE dengan file status `71` (bad character)
  karena area record punya sisa data tak terinisialisasi dari siklus
  sebelumnya.
- **Skip-and-log, bukan crash, untuk baris rusak** — satu baris transaksi
  yang tidak valid (tipe bukan `D`/`C`, atau kolom jumlah bukan angka)
  tidak menghentikan batch; dicatat ke `data/errors.log` dan dilewati.
  Ini meniru sifat batch job mainframe sungguhan: satu record cacat di
  file jutaan baris tidak boleh menggagalkan settlement semua akun lain.
- **Tabel akun in-memory (`OCCURS`), bukan sort-merge** — karena volume
  data contoh ini kecil, saldo per akun disimpan di tabel `OCCURS 50
  TIMES` yang dicari linear. Pola mainframe sungguhan untuk data besar
  biasanya men-sort file transaksi lebih dulu lalu memakai
  control-break/match-merge logic — sengaja disederhanakan di sini demi
  keterbacaan, dicatat sebagai simplifikasi yang disengaja.
