# Mobile E2E Report

**Date:** 2026-11-11  
**Result:** PASS

Command:

```bash
cd tests
BASE_URL=http://127.0.0.1:5173 API_URL=http://127.0.0.1:8010/api npm test
```

Result: **12 passed, 0 failed, 0 skipped** across the combined mobile/desktop
suite.

Mobile widths covered: 320, 360, 375, 390, 412, 430, 600, and 768px.

Verified:

- Mobile shell and bottom navigation.
- No horizontal overflow.
- Navigation and deep links.
- 404 page and recovery to home.
- Header sizing.
- Touch targets and readable form inputs.
- Bottom navigation overlap protection.
- Console, page, and request errors.
