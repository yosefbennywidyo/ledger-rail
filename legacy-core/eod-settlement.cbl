      *> =================================================================
      *> EOD-SETTLEMENT
      *>
      *> End-of-day settlement batch job for the "legacy-core" component
      *> of ledger-rail. This is a standalone illustration of a
      *> mainframe-style batch program: it does NOT talk to the Go
      *> ledger-service over the network. It reads flat, fixed-width
      *> files and writes a flat, fixed-width report - the "strangler
      *> pattern" file-exchange bridge a real bank would put between an
      *> old core and a modern one.
      *>
      *> Inputs:
      *>   data/opening-balances.dat  (optional) starting balance per
      *>                              account before today's activity.
      *>                              Missing file => every account
      *>                              starts at zero.
      *>   data/transactions.dat     today's debits/credits, one record
      *>                              per line.
      *>
      *> Output:
      *>   data/balances.dat          one line per account: id + closing
      *>                              balance, human-readable.
      *>   data/errors.log            one line per skipped/malformed
      *>                              transaction record, so a bad line
      *>                              never aborts the whole batch.
      *> =================================================================
       IDENTIFICATION DIVISION.
       PROGRAM-ID. EOD-SETTLEMENT.
       AUTHOR. LEDGER-RAIL-LEGACY-CORE.

       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT OPENING-BALANCE-FILE
               ASSIGN TO "data/opening-balances.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-OPEN-BAL-STATUS.

           SELECT TRANSACTION-FILE
               ASSIGN TO "data/transactions.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-TRANS-STATUS.

           SELECT BALANCE-REPORT-FILE
               ASSIGN TO "data/balances.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-BALANCE-STATUS.

           SELECT ERROR-LOG-FILE
               ASSIGN TO "data/errors.log"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-ERROR-STATUS.

       DATA DIVISION.
       FILE SECTION.
       FD  OPENING-BALANCE-FILE.
           COPY "opening-balance-record.cpy".

       FD  TRANSACTION-FILE.
           COPY "transaction-record.cpy".

       FD  BALANCE-REPORT-FILE.
       01  BALANCE-REPORT-RECORD.
           05  BR-ACCOUNT-ID           PIC X(10).
           05  FILLER                  PIC X(02)  VALUE SPACES.
           05  BR-BALANCE-DISPLAY      PIC -ZZZ,ZZZ,ZZ9.99.

       FD  ERROR-LOG-FILE.
       01  ERROR-LOG-RECORD            PIC X(80).

       WORKING-STORAGE SECTION.
       01  WS-FILE-STATUSES.
           05  WS-OPEN-BAL-STATUS      PIC XX     VALUE "00".
           05  WS-TRANS-STATUS         PIC XX     VALUE "00".
           05  WS-BALANCE-STATUS       PIC XX     VALUE "00".
           05  WS-ERROR-STATUS         PIC XX     VALUE "00".

       01  WS-OPEN-BAL-EOF             PIC X      VALUE "N".
           88  OPEN-BAL-EOF                       VALUE "Y".

       01  WS-TRANS-EOF                PIC X      VALUE "N".
           88  TRANS-EOF                          VALUE "Y".

       01  WS-VALID-FLAG               PIC X      VALUE "Y".
           88  VALID-TRANSACTION                  VALUE "Y".

       01  WS-COUNTERS.
           05  WS-OPEN-BAL-READ        PIC 9(6)   VALUE ZERO.
           05  WS-TRANS-READ           PIC 9(6)   VALUE ZERO.
           05  WS-TRANS-SKIPPED        PIC 9(6)   VALUE ZERO.
           05  WS-ACCOUNT-COUNT        PIC 9(4)   VALUE ZERO.
           05  WS-IDX                  PIC 9(4)   VALUE ZERO.
           05  WS-FOUND-IDX            PIC 9(4)   VALUE ZERO.

       *> In-memory account table built up while reading both input
       *> files. Linear-searched by account id - fine at batch sizes
       *> this illustration deals with; a real mainframe job would
       *> instead rely on the input being sorted/matched by account key.
       01  WS-ACCOUNT-TABLE.
           05  WS-ACCOUNT-ENTRY OCCURS 50 TIMES.
               10  WS-ACCT-ID          PIC X(10)  VALUE SPACES.
               10  WS-ACCT-BALANCE     PIC S9(13) VALUE ZERO.

       01  WS-LOOKUP-ID                PIC X(10)  VALUE SPACES.
       01  WS-LOOKUP-DELTA             PIC S9(13) VALUE ZERO.
       01  WS-DISPLAY-BALANCE          PIC S9(11)V99 VALUE ZERO.

       PROCEDURE DIVISION.
       MAIN-PROCEDURE.
           DISPLAY "EOD-SETTLEMENT: starting batch run"
           PERFORM OPEN-FILES
           PERFORM LOAD-OPENING-BALANCES
           PERFORM PROCESS-TRANSACTIONS
           PERFORM WRITE-BALANCE-REPORT
           PERFORM CLOSE-FILES
           DISPLAY "EOD-SETTLEMENT: opening balances read = " WS-OPEN-BAL-READ
           DISPLAY "EOD-SETTLEMENT: transactions read     = " WS-TRANS-READ
           DISPLAY "EOD-SETTLEMENT: transactions skipped  = " WS-TRANS-SKIPPED
           DISPLAY "EOD-SETTLEMENT: accounts in report    = " WS-ACCOUNT-COUNT
           DISPLAY "EOD-SETTLEMENT: batch run complete"
           STOP RUN.

       OPEN-FILES.
           OPEN INPUT OPENING-BALANCE-FILE
           IF WS-OPEN-BAL-STATUS = "35"
               DISPLAY "EOD-SETTLEMENT: no opening-balances.dat found, "
                   "all accounts start today at zero"
               MOVE "Y" TO WS-OPEN-BAL-EOF
           END-IF
           OPEN INPUT TRANSACTION-FILE
           OPEN OUTPUT BALANCE-REPORT-FILE
           OPEN OUTPUT ERROR-LOG-FILE.

       LOAD-OPENING-BALANCES.
           PERFORM UNTIL OPEN-BAL-EOF
               READ OPENING-BALANCE-FILE
                   AT END
                       MOVE "Y" TO WS-OPEN-BAL-EOF
                   NOT AT END
                       ADD 1 TO WS-OPEN-BAL-READ
                       PERFORM APPLY-OPENING-BALANCE
               END-READ
           END-PERFORM.

       APPLY-OPENING-BALANCE.
           MOVE OB-ACCOUNT-ID TO WS-LOOKUP-ID
           IF OB-SIGN = "-"
               COMPUTE WS-LOOKUP-DELTA = 0 - OB-BALANCE-CENTS
           ELSE
               MOVE OB-BALANCE-CENTS TO WS-LOOKUP-DELTA
           END-IF
           PERFORM APPLY-DELTA-TO-ACCOUNT.

       PROCESS-TRANSACTIONS.
           PERFORM UNTIL TRANS-EOF
               READ TRANSACTION-FILE
                   AT END
                       MOVE "Y" TO WS-TRANS-EOF
                   NOT AT END
                       ADD 1 TO WS-TRANS-READ
                       PERFORM VALIDATE-AND-APPLY-TRANSACTION
               END-READ
           END-PERFORM.

       *> A record is only ever skipped-and-logged here, never allowed
       *> to abort the run: a single malformed line in a daily file of
       *> thousands must not stop settlement for every other account.
       VALIDATE-AND-APPLY-TRANSACTION.
           MOVE "Y" TO WS-VALID-FLAG

           IF TR-ACCOUNT-ID = SPACES
               MOVE "N" TO WS-VALID-FLAG
           END-IF

           IF TR-TRANS-TYPE NOT = "D" AND TR-TRANS-TYPE NOT = "C"
               MOVE "N" TO WS-VALID-FLAG
           END-IF

           IF TR-AMOUNT-CENTS NOT NUMERIC
               MOVE "N" TO WS-VALID-FLAG
           END-IF

           IF VALID-TRANSACTION
               MOVE TR-ACCOUNT-ID TO WS-LOOKUP-ID
               IF TR-TRANS-TYPE = "D"
                   COMPUTE WS-LOOKUP-DELTA = 0 - TR-AMOUNT-CENTS
               ELSE
                   MOVE TR-AMOUNT-CENTS TO WS-LOOKUP-DELTA
               END-IF
               PERFORM APPLY-DELTA-TO-ACCOUNT
           ELSE
               PERFORM LOG-SKIPPED-TRANSACTION
           END-IF.

       LOG-SKIPPED-TRANSACTION.
           ADD 1 TO WS-TRANS-SKIPPED
           MOVE SPACES TO ERROR-LOG-RECORD
           STRING "SKIPPED record #" DELIMITED BY SIZE
                   WS-TRANS-READ DELIMITED BY SIZE
                   ": [" DELIMITED BY SIZE
                   TRANSACTION-RECORD DELIMITED BY SIZE
                   "]" DELIMITED BY SIZE
               INTO ERROR-LOG-RECORD
           WRITE ERROR-LOG-RECORD.

       *> Shared by both input files: find the account in the in-memory
       *> table and add the delta, or create a new zero-balance entry
       *> for it (the "assume zero if no opening balance was given"
       *> rule) and add the delta to that.
       APPLY-DELTA-TO-ACCOUNT.
           MOVE 0 TO WS-FOUND-IDX
           PERFORM VARYING WS-IDX FROM 1 BY 1
                   UNTIL WS-IDX > WS-ACCOUNT-COUNT
               IF WS-ACCT-ID(WS-IDX) = WS-LOOKUP-ID
                   MOVE WS-IDX TO WS-FOUND-IDX
                   EXIT PERFORM
               END-IF
           END-PERFORM

           IF WS-FOUND-IDX = 0
               IF WS-ACCOUNT-COUNT >= 50
                   DISPLAY "EOD-SETTLEMENT: ERROR account table full, "
                       "cannot add " WS-LOOKUP-ID
               ELSE
                   ADD 1 TO WS-ACCOUNT-COUNT
                   MOVE WS-LOOKUP-ID TO WS-ACCT-ID(WS-ACCOUNT-COUNT)
                   MOVE WS-LOOKUP-DELTA TO WS-ACCT-BALANCE(WS-ACCOUNT-COUNT)
               END-IF
           ELSE
               ADD WS-LOOKUP-DELTA TO WS-ACCT-BALANCE(WS-FOUND-IDX)
           END-IF.

       WRITE-BALANCE-REPORT.
           PERFORM VARYING WS-IDX FROM 1 BY 1
                   UNTIL WS-IDX > WS-ACCOUNT-COUNT
               MOVE SPACES TO BALANCE-REPORT-RECORD
               MOVE WS-ACCT-ID(WS-IDX) TO BR-ACCOUNT-ID
               COMPUTE WS-DISPLAY-BALANCE = WS-ACCT-BALANCE(WS-IDX) / 100
               MOVE WS-DISPLAY-BALANCE TO BR-BALANCE-DISPLAY
               WRITE BALANCE-REPORT-RECORD
           END-PERFORM.

       CLOSE-FILES.
           IF WS-OPEN-BAL-STATUS NOT = "35"
               CLOSE OPENING-BALANCE-FILE
           END-IF
           CLOSE TRANSACTION-FILE
           CLOSE BALANCE-REPORT-FILE
           CLOSE ERROR-LOG-FILE.
