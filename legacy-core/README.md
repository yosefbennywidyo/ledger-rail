# legacy-core

A standalone COBOL batch program (GnuCOBOL) simulating an end-of-day (EOD)
settlement job — the kind of mainframe batch that still closes the books
at most large banks. It reads fixed-width, mainframe-style files and
writes a fixed-width closing-balance report. It does **not** talk to
`ledger-service` (Go) over the network; the two are reconciled offline by
file exchange, illustrating the "strangler pattern" — an old core kept in
place and bridged to a modern stack, rather than replaced outright.

See `BEST_PRACTICES.md` for the conventions applied and why, and
`bahasa-teknologi-perbankan.md` / `project-requirements.md` (in the parent
`explore/` directory) for the wider design intent.

## Prerequisites

Install GnuCOBOL via Homebrew (not managed by `mise` — no official plugin
exists in the mise registry yet):

```bash
brew install gnucobol
cobc --version
```

This was built and verified against:

```
cobc (GnuCOBOL) 3.2.0
```

## Files

```
eod-settlement.cbl              program batch utama (free-format COBOL)
copybooks/
  transaction-record.cpy        layout data/transactions.dat (23 bytes/line)
  opening-balance-record.cpy    layout data/opening-balances.dat (23 bytes/line)
data/
  transactions.dat              input harian — sample data (10 baris, 2 sengaja rusak)
  opening-balances.dat          input opsional — saldo awal per akun
  balances.dat                  output — dihasilkan tiap run, di-overwrite
  errors.log                    output — baris yang di-skip, di-overwrite tiap run
```

## Build

```bash
cd legacy-core
cobc -x -free eod-settlement.cbl -o eod-settlement -I copybooks
```

- `-x` — build an executable (not a shared/callable module).
- `-free` — compile as free-format source (see `BEST_PRACTICES.md` for why
  this dialect was chosen over classic fixed-format).
- `-I copybooks` — tell `cobc` where to find files referenced by `COPY`
  statements in the `.cbl` source.

This should compile cleanly with no warnings or errors.

## Run

```bash
./eod-settlement
```

Run it from inside `legacy-core/` — the file paths in `eod-settlement.cbl`
(`data/transactions.dat` etc.) are relative to the current working
directory, matching how a mainframe JCL job would reference dataset names
relative to a fixed run location.

Expected console output:

```
EOD-SETTLEMENT: starting batch run
EOD-SETTLEMENT: opening balances read = 000004
EOD-SETTLEMENT: transactions read     = 000010
EOD-SETTLEMENT: transactions skipped  = 000002
EOD-SETTLEMENT: accounts in report    = 0005
EOD-SETTLEMENT: batch run complete
```

- `data/opening-balances.dat` is optional. If deleted/missing, the program
  logs that fact and every account starts the day at zero instead of
  aborting — try `mv data/opening-balances.dat /tmp && ./eod-settlement`
  and compare `data/balances.dat`, then move it back.
- Two of the ten sample transaction lines are intentionally malformed
  (a non-numeric amount, and an invalid transaction type) to exercise the
  skip-and-log error path. They show up in `data/errors.log`, not as a
  crash.

## Verifying the output

After a run, inspect `data/balances.dat` — one line per account, account
id followed by a human-readable signed balance:

```
ACC0000001         4,950.00
ACC0000002           200.00
ACC0000003         8,000.00
ACC0000004           500.00
ACC0000005           200.00
```

Manual check for `ACC0000001` against the sample data:

- Opening balance (`data/opening-balances.dat`): `+000000500000` = **+5,000.00**
- Transaction 1 (`data/transactions.dat`): `D 000000010000` = debit 100.00 → **-100.00**
- Transaction 2: `C 000000005000` = credit 50.00 → **+50.00**
- Expected closing balance: `5000.00 - 100.00 + 50.00 = 4950.00`

Matches the `4,950.00` in `data/balances.dat`. `ACC0000005` has no opening
balance record at all — it exercises the "missing account defaults to
zero" rule (`0.00 + 300.00 credit - 100.00 debit = 200.00`, which also
matches the output above).
