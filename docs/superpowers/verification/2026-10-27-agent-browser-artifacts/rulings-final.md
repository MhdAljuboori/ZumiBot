# Agent browser execution decisions

Chronological rulings made while executing the approved plan. Each entry preserves the decision and its cost if wrong; the process-identity and download-reservation refinements supersede their earlier intermediate proposals.

1. Continue in the existing built-in-borwser feature checkout. Cost if wrong: Moving the changes to another checkout if isolation was insufficient.

2. Define shared contracts first and wire optional application APIs in Task 6. Cost if wrong: Reordering integration work if the seam was needed earlier.

3. Keep Chromium cleanup in the worker runtime, with the backend manager authoritative. Cost if wrong: Revising process supervision and cleanup.

4. Treat the extracted Task 10 trailing reference/self-review material as context. Cost if wrong: Reorganizing reports if additional scope was intended.

5. Expose generation, tab status and change notifications on browser instances. Cost if wrong: A localized adapter interface revision.

6. Give manual browser input a distinct typed adapter operation. Cost if wrong: A localized input adapter revision.

7. Resolve profile ownership by opaque server-issued profile ID. Cost if wrong: Revising the profile lookup seam.

8. Await reference invalidation before resumed agent work. Cost if wrong: Revising the release/lease transition seam.

9. Use an answer-only connection that cannot launch or stream a browser. Cost if wrong: Revising card-answer transport integration.

10. Report a browser closed only after authoritative worker/Chromium cleanup. Cost if wrong: Revising crash and relaunch lifecycle handling.

11. Support Linux process identity proof and fail closed elsewhere. Cost if wrong: A separate implementation is needed for other operating systems.

12. Replace ambiguous argv/title ownership matching with exact launch identity. The intermediate environment-marker rule was refined: markers identify the worker; controlled-launch CDP PID/start proof identifies Chromium. Cost if wrong: Unproved cleanup remains unavailable rather than signalling unrelated processes.

13. Reserve capacity when failed-launch cleanup is uncertain, and check unresolved ownership globally before new launches. Cost if wrong: Conservative browser unavailability until recovery is possible.

14. Bind browser turn creation to an IPC service instance rather than module-global state. Cost if wrong: A localized application constructor revision.

15. Permit a bounded bridge-child exit after fatal output overflow and synchronous cancellation. Cost if wrong: Revising bridge shutdown liveness handling.

16. Keep cancellation reservations until actual SDK completion or queued-write completion. Cost if wrong: Revising bridge request accounting.

17. Authenticate answers without replacing another watch; validate a pending request before releasing its controller. Cost if wrong: Revising answer/control ordering.

18. Validate generation/tab inside the queued manual navigation operation. Cost if wrong: Revising the navigation adapter seam.

19. Keep text chat usable when Chromium or browser metadata is unavailable, without overwriting corrupt metadata. Cost if wrong: Adding maintenance/recovery handling if broader availability is required.

20. Use a shared lazy initial recovery checkpoint before any browser launch. Cost if wrong: Browser recovery failures remain blocked until restart.

21. Persist bounded summaries for app-owned browser tools while retaining original private permission payloads. Cost if wrong: Revising transcript redaction if more detail is needed.

22. Cache profile identity per logical turn and issue fresh capabilities for every CLI attempt; clear/delete never silently rebind an active turn. Cost if wrong: A larger rename/retry transaction revision.

23. Keep file authority/accounting in the parent and use bounded acknowledged worker transfers with live Chromium progress cancellation. Cost if wrong: A localized file-transfer protocol revision.

24. Remove exact download scratch directories only after authoritative ownership recovery. Cost if wrong: Revising conservative crash-scratch recovery.

25. Count both retained download source and staged copy: reserve 50 MiB until confirmed source cleanup, including failure/expiry/clear tombstones. Cost if wrong: Conservative rejection of some otherwise-small concurrent transfers.

26. Limit browser-check cleanup assertions to the actual owned profile and verified processes; preserve unrelated temporary files. Cost if wrong: add further assertions for app-owned temporary artifacts.
