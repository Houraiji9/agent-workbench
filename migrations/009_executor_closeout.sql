-- Run JSON stores closeout and closeout_history. Workbench.migrateCloseout moves
-- unaccepted legacy passes to awaiting_closeout inside the same transaction.
-- Accepted tasks, original results, reviews and execution packages stay intact.
SELECT 1;
