#!/usr/bin/env python3
"""Generate the dry-run page from the live one.

The demo is derived rather than hand-maintained so the two cannot drift:
regenerate after any change to gc_scholarship_test.html and the rehearsal
always exercises exactly the code the students will get.

What it changes, and nothing else:
  * carries the demo key on every API call, which is what lets the server
    waive the window check (the key is verified server-side; the page just
    presents it)
  * a standing banner so nobody mistakes this for the live page
  * the Start Test button is always shown, whatever the countdown says

Run:  python3 gc_scholarship_build_demo.py
"""
import re, sys, pathlib

SRC = pathlib.Path('gc_scholarship_test.html')
OUT = pathlib.Path('gc_scholarship_test_demo.html')
DEMO_KEY = 'gcb-dryrun-d624e6437556bf1f8db0bc05'

s = SRC.read_text(encoding='utf-8')

def sub(old, new, why):
    global s
    if old not in s:
        sys.exit('build_demo: anchor missing (%s). Has the live page changed?' % why)
    s = s.replace(old, new, 1)

sub('<title>Scholarship Test — Global Careers by Testbook</title>',
    '<title>[DEMO] Scholarship Test — Global Careers by Testbook</title>', 'title')

sub('</style>', """
/* ---- dry-run only ---- */
#demo-bar{position:sticky;top:0;z-index:60;background:#7C3AED;color:#fff;
  padding:9px 14px;text-align:center;font-size:13px;font-weight:700;letter-spacing:.02em}
#demo-bar span{font-weight:400;opacity:.9}
@media (max-width:600px){#demo-bar{font-size:11.5px;padding:8px 10px}}
</style>""", 'demo bar css')

sub('<div class="screen active" id="s-landing">',
    """<div id="demo-bar">DEMO — INTERNAL DRY RUN
  <span>&nbsp;·&nbsp; the live page opens at 2:00 PM on Sun 18 Oct. Nothing here counts.</span></div>

<div class="screen active" id="s-landing">""", 'demo bar markup')

# The key rides on every call; the server decides where it means anything.
sub("body: JSON.stringify(Object.assign({ action: action }, body || {}))",
    "body: JSON.stringify(Object.assign({ action: action, demo_key: DEMO_KEY }, body || {}))",
    'api demo key')

sub("var WA_URL = 'https://chat.whatsapp.com/Ho92fbDgoMA7fCVTBNpgh0';",
    "var WA_URL = 'https://chat.whatsapp.com/Ho92fbDgoMA7fCVTBNpgh0';\n"
    "var DEMO_KEY = '%s';   // dry-run only; absent from the live page" % DEMO_KEY,
    'demo key constant')

# The countdown still runs for real; the button simply ignores it.
sub("""  $('start-zone').style.display = (live && !done) ? 'block' : 'none';""",
    """  $('start-zone').style.display = 'block';          // DEMO: always available
  $('btn-start-test').textContent = 'START TEST (DEMO)';
  $('start-note').innerHTML = 'Demo mode \\u2014 this button ignores the countdown. '
    + 'On the live page it appears only at 2:00 PM on 18 October.';
  // A demo attempt is wiped and re-run server-side, so the same number can
  // go round again. Showing the live page's "already taken" lock here would
  // tell a tester the opposite of what will actually happen, so the form
  // stays put and the lock panel is suppressed.
  done = false;""",
    'always-on start button')

OUT.write_text(s, encoding='utf-8')
print('wrote %s (%d lines)' % (OUT, len(s.splitlines())))
