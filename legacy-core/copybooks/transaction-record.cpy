      *> ---------------------------------------------------------------
      *> TRANSACTION-RECORD  (23 bytes) - data/transactions.dat
      *>
      *> Fixed-width, mainframe-style record, one per line. Field
      *> layout (byte offsets, 1-based):
      *>
      *>   TR-ACCOUNT-ID     PIC X(10)   cols  1-10  account identifier,
      *>                                       e.g. "ACC0000001",
      *>                                       space-padded on the right.
      *>   TR-TRANS-TYPE     PIC X(01)   col   11     "D" = debit,
      *>                                       "C" = credit. Any other
      *>                                       value is invalid and the
      *>                                       record is skipped.
      *>   TR-AMOUNT-CENTS   PIC 9(12)   cols 12-23   unsigned amount in
      *>                                       cents, zero-padded, e.g.
      *>                                       "000000010000" = 100.00.
      *> ---------------------------------------------------------------
       01  TRANSACTION-RECORD.
           05  TR-ACCOUNT-ID           PIC X(10).
           05  TR-TRANS-TYPE           PIC X(01).
           05  TR-AMOUNT-CENTS         PIC 9(12).
