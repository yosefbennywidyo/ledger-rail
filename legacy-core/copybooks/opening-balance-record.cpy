      *> ---------------------------------------------------------------
      *> OPENING-BALANCE-RECORD  (23 bytes) - data/opening-balances.dat
      *>
      *> Optional input file. If it does not exist, every account is
      *> assumed to start the day at a zero balance. If present, one
      *> line per account seeds the starting balance before the day's
      *> transactions are applied. Field layout (1-based):
      *>
      *>   OB-ACCOUNT-ID      PIC X(10)  cols  1-10  account identifier,
      *>                                       same convention as
      *>                                       TR-ACCOUNT-ID.
      *>   OB-SIGN            PIC X(01)  col   11     "+" or "-".
      *>   OB-BALANCE-CENTS   PIC 9(12)  cols 12-23   unsigned magnitude
      *>                                       of the opening balance in
      *>                                       cents, zero-padded.
      *> ---------------------------------------------------------------
       01  OPENING-BALANCE-RECORD.
           05  OB-ACCOUNT-ID           PIC X(10).
           05  OB-SIGN                 PIC X(01).
           05  OB-BALANCE-CENTS        PIC 9(12).
