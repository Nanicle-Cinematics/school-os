# Emits nine .dc.html artboards: three visual directions x three real screens.
# Structure and numbers are lifted from the running app (ui.tsx, ReportCard,
# assessment-templates, the demo school); only palette, type and density vary.
import json, pathlib

D = {
 "A": dict(letter="A", name="Academic Green",
   bg="#F6F7F5", card="#FFFFFF", border="#DFE3DD", soft="#EDF0EB",
   text="#16211C", muted="#5B6B62", faint="#8A9990",
   primary="#1B4D3E", onprimary="#FFFFFF", accent="#B5892B", accentsoft="#F6EFDD",
   radius=12, rsm=8, rowpad=10, headbg="#F1F3EF",
   body="'Public Sans'", disp="'Newsreader'", bodyfb="system-ui, sans-serif", dispfb="Georgia, serif",
   link="https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,600;1,400&family=Public+Sans:wght@400;500;600;700&display=swap",
   dispweight="600", headcase="none", headls="-0.01em"),
 "B": dict(letter="B", name="Civic Navy",
   bg="#F1F4F7", card="#FFFFFF", border="#D8E0E8", soft="#EBF0F5",
   text="#0E1B29", muted="#4A5C6E", faint="#7C8B9A",
   primary="#12355B", onprimary="#FFFFFF", accent="#0E7C86", accentsoft="#E2F1F2",
   radius=6, rsm=4, rowpad=7, headbg="#E9EFF5",
   body="'IBM Plex Sans'", disp="'IBM Plex Serif'", bodyfb="system-ui, sans-serif", dispfb="Georgia, serif",
   link="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:wght@500;600&display=swap",
   dispweight="600", headcase="none", headls="-0.005em"),
 "C": dict(letter="C", name="Warm Paper",
   bg="#FBF6EE", card="#FFFDF8", border="#E5DACA", soft="#F0E8DA",
   text="#2B2118", muted="#6E6153", faint="#9C8E7D",
   primary="#9C4A2F", onprimary="#FFF8F2", accent="#5C6B3C", accentsoft="#EFEADD",
   radius=14, rsm=10, rowpad=12, headbg="#F3EDE1",
   body="'Karla'", disp="'Instrument Serif'", bodyfb="system-ui, sans-serif", dispfb="Georgia, serif",
   link="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Karla:wght@400;500;600;700&display=swap",
   dispweight="400", headcase="none", headls="0"),
}

def shell(t, inner, css=""):
    return f'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="{t['link']}">
  <style>
    body {{ margin: 0; font-family: {t['body']}, {t['bodyfb']}; background: {t['bg']}; color: {t['text']}; -webkit-font-smoothing: antialiased; }}
    * {{ box-sizing: border-box; }}
    a {{ color: {t['primary']}; text-decoration: none; }}
    a:hover {{ color: {t['accent']}; }}
    table {{ border-collapse: collapse; width: 100%; }}
    .disp {{ font-family: {t['disp']}, {t['dispfb']}; font-weight: {t['dispweight']}; letter-spacing: {t['headls']}; }}
    .tabnum {{ font-variant-numeric: tabular-nums; }}
    {css}
  </style>
</helmet>
{inner}
</x-dc>
</body>
</html>
'''

def crest(t, size=40, mono=False):
    ring = t['primary'] if not mono else "#1a1a1a"
    gold = t['accent'] if not mono else "#666"
    return f'''<svg width="{size}" height="{size}" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <path d="M24 3 L42 9 V25 C42 35 34 42 24 45 C14 42 6 35 6 25 V9 Z" fill="{ring}"/>
  <path d="M24 7 L38 11.5 V25 C38 33 31.5 39 24 41.5 C16.5 39 10 33 10 25 V11.5 Z" fill="none" stroke="{gold}" stroke-width="1.5"/>
  <path d="M17 30 L24 15 L31 30 M20 25 H28" stroke="{gold}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>'''

def icon(name, color):
    p = {
      "grid": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      "users": '<path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.87"/>',
      "book": '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
      "cash": '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
      "cog": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9z"/>',
      "chart": '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
    }[name]
    return f'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{p}</svg>'

NAV = [("grid","Dashboard","Overview"),("users","Students","People"),("book","Mark sheet","Academics"),
       ("chart","Results",None),("cash","Invoices","Finance"),("cog","Settings","School")]

def sidebar(t, active):
    out = []
    cur = None
    for ic, label, section in NAV:
        if section and section != cur:
            cur = section
            out.append(f'<p style="margin:18px 0 6px;padding:0 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:{t["faint"]}">{section}</p>')
        on = label == active
        bg = f'background:{t["primary"]};color:{t["onprimary"]};' if on else f'color:{t["muted"]};'
        col = t['onprimary'] if on else t['faint']
        out.append(f'<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:{t["rsm"]}px;font-size:14px;font-weight:{"600" if on else "400"};{bg}">{icon(ic,col)}<span>{label}</span></div>')
    return f'''<aside style="width:236px;flex:none;border-right:1px solid {t['border']};background:{t['card']};padding:12px 10px;">
  <div style="display:flex;flex-direction:column;gap:1px;">{''.join(out)}</div>
</aside>'''

def topbar(t, crumb):
    return f'''<header style="height:60px;flex:none;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid {t['border']};background:{t['card']};">
  {crest(t,34)}
  <div style="min-width:0;">
    <p class="disp" style="margin:0;font-size:15px;color:{t['text']};">St. Mary&rsquo;s Preparatory &amp; JHS</p>
    <p style="margin:0;font-size:12px;color:{t['muted']};">{crumb}</p>
  </div>
  <div style="margin-left:auto;display:flex;align-items:center;gap:12px;">
    <div style="text-align:right;">
      <p style="margin:0;font-size:13px;font-weight:600;color:{t['text']};">Nana Kwabena Osei</p>
      <p style="margin:0;font-size:11px;color:{t['muted']};">Proprietor</p>
    </div>
    <div style="width:32px;height:32px;border-radius:50%;background:{t['accentsoft']};color:{t['primary']};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">NO</div>
  </div>
</header>'''

def card(t, title, body, action=""):
    head = ""
    if title:
        head = f'''<div style="display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid {t['soft']};">
      <h2 style="margin:0;font-size:14px;font-weight:600;color:{t['text']};">{title}</h2>{action}</div>'''
    return f'<section style="overflow:hidden;border-radius:{t["radius"]}px;border:1px solid {t["border"]};background:{t["card"]};">{head}{body}</section>'

def stat(t, label, value, sub, accent=False):
    col = t['primary'] if accent else t['text']
    return f'''<div style="border-radius:{t['radius']}px;border:1px solid {t['border']};background:{t['card']};padding:15px;">
  <p style="margin:0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:{t['muted']};">{label}</p>
  <p class="tabnum disp" style="margin:6px 0 0;font-size:27px;color:{col};">{value}</p>
  <p style="margin:3px 0 0;font-size:12px;color:{t['faint']};">{sub}</p>
</div>'''

def th(t):
    return f'background:{t["headbg"]};border-bottom:1px solid {t["border"]};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:{t["muted"]};text-align:left;padding:9px 14px;'
def td(t, extra=""):
    return f'padding:{t["rowpad"]}px 14px;font-size:13.5px;color:{t["text"]};border-bottom:1px solid {t["soft"]};{extra}'

# ── Dashboard ───────────────────────────────────────────────────────────────
def dashboard(t):
    stats = "".join([
      stat(t,"Students","44","24 boys · 20 girls"),
      stat(t,"Staff","8","11 classes"),
      stat(t,"Collected","GH₵18,450","62% of GH₵29,600 billed", True),
      stat(t,"Outstanding","GH₵11,150","17 students owing"),
    ])
    pay_rows = "".join(
      f'<tr><td style="{td(t)}">{n}</td><td style="{td(t)}font-size:12.5px;color:{t["muted"]};">{m}</td>'
      f'<td class="tabnum" style="{td(t)}text-align:right;font-weight:600;">GH₵{a}</td></tr>'
      for n,m,a in [("Abena Mensah","Mobile money","450.00"),("Kwesi Owusu","Cash","300.00"),
                    ("Yaa Boateng","Mobile money","1,200.00"),("Kofi Antwi","Bank deposit","275.00")])
    payments = card(t,"Recent payments",
      f'<table><thead><tr><th style="{th(t)}">Student</th><th style="{th(t)}">Method</th><th style="{th(t)}text-align:right;">Amount</th></tr></thead><tbody>{pay_rows}</tbody></table>')

    bars = ""
    for lvl, n in [("KG 1",4),("KG 2",5),("Basic 1",6),("Basic 2",5),("Basic 3",4),
                   ("Basic 4",5),("Basic 5",6),("Basic 6",4),("JHS 1",3),("JHS 2",2)]:
        w = int(n/6*100)
        bars += (f'<div style="display:flex;align-items:center;gap:10px;">'
                 f'<span style="width:58px;font-size:12px;color:{t["muted"]};">{lvl}</span>'
                 f'<div style="flex:1;height:9px;border-radius:99px;background:{t["soft"]};overflow:hidden;">'
                 f'<div style="width:{w}%;height:100%;background:{t["primary"]};border-radius:99px;"></div></div>'
                 f'<span class="tabnum" style="width:20px;text-align:right;font-size:12px;font-weight:600;color:{t["text"]};">{n}</span></div>')
    enrol = card(t,"Enrolment by level", f'<div style="display:flex;flex-direction:column;gap:9px;padding:15px;">{bars}</div>')

    owe_rows = "".join(
      f'<tr><td style="{td(t)}">{n}</td><td style="{td(t)}font-size:12.5px;color:{t["muted"]};">{c}</td>'
      f'<td class="tabnum" style="{td(t)}text-align:right;font-weight:600;color:{t["primary"]};">GH₵{a}</td></tr>'
      for n,c,a in [("Ama Darko","Basic 5 Gold","1,325.00"),("Kwabena Asare","JHS 1 A","1,325.00"),
                    ("Efua Nyarko","Basic 3 A","1,125.00")])
    owing = card(t,"Largest balances",
      f'<table><thead><tr><th style="{th(t)}">Student</th><th style="{th(t)}">Class</th><th style="{th(t)}text-align:right;">Owing</th></tr></thead><tbody>{owe_rows}</tbody></table>')

    body = f'''<div style="display:flex;flex-direction:column;height:100%;">
  {topbar(t,"First Term · 2026/2027")}
  <div style="display:flex;flex:1;min-height:0;">
    {sidebar(t,"Dashboard")}
    <main style="flex:1;padding:22px;overflow:hidden;">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px;">
        <div>
          <h1 class="disp" style="margin:0;font-size:25px;color:{t['text']};">Good day, Nana</h1>
          <p style="margin:3px 0 0;font-size:13.5px;color:{t['muted']};">First Term closes on 18 December. 17 families still owe.</p>
        </div>
        <div style="display:flex;gap:8px;">
          <div style="border:1px solid {t['border']};background:{t['card']};border-radius:{t['rsm']}px;padding:8px 13px;font-size:13px;font-weight:500;color:{t['text']};">Print invoices</div>
          <div style="background:{t['primary']};color:{t['onprimary']};border-radius:{t['rsm']}px;padding:8px 13px;font-size:13px;font-weight:600;">Record payment</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:13px;margin-bottom:15px;">{stats}</div>
      <div style="display:grid;grid-template-columns:repeat(2, minmax(0,1fr));gap:15px;">
        <div style="display:flex;flex-direction:column;gap:15px;">{payments}{owing}</div>
        {enrol}
      </div>
    </main>
  </div>
</div>'''
    return shell(t, body)

# ── Mark sheet ──────────────────────────────────────────────────────────────
COMPONENTS = [("Class Test 1",20),("Class Test 2",20),("Group Work 1",10),
              ("Group Work 2",10),("Project",20),("Exam",100)]
PUPILS = [("Abena Mensah",[17,16,9,8,17,78]),("Kofi Antwi",[14,15,7,9,15,64]),
          ("Yaa Boateng",[19,18,10,9,19,91]),("Kwesi Owusu",[12,11,6,7,13,52]),
          ("Efua Darko",[16,17,8,10,16,73]),("Kwabena Asare",[10,13,7,6,12,48]),
          ("Adwoa Frimpong",[18,17,9,9,18,84]),("Yaw Nyarko",[15,14,8,8,14,61])]

def marksheet(t):
    heads = "".join(f'<th style="{th(t)}text-align:center;white-space:nowrap;">{n}<br><span style="font-weight:500;text-transform:none;letter-spacing:0;color:{t["faint"]};">/{m}</span></th>' for n,m in COMPONENTS)
    rows = ""
    for i,(name,sc) in enumerate(PUPILS):
        cells = "".join(
          f'<td style="{td(t)}text-align:center;padding-left:6px;padding-right:6px;">'
          f'<span class="tabnum" style="display:inline-block;min-width:46px;border:1px solid {t["border"]};border-radius:{t["rsm"]}px;background:{t["bg"]};padding:5px 0;font-size:13px;font-weight:600;">{v}</span></td>'
          for v in sc)
        total = round(sum(sc[:5])/80*50 + sc[5]/100*50, 1)
        rows += (f'<tr><td style="{td(t)}white-space:nowrap;"><span style="color:{t["faint"]};font-size:12px;margin-right:8px;" class="tabnum">{i+1}</span>{name}</td>'
                 f'{cells}<td class="tabnum" style="{td(t)}text-align:center;font-weight:700;color:{t["primary"]};background:{t["accentsoft"]};">{total}</td></tr>')
    table = f'''<div style="overflow:hidden;">
  <table><thead><tr><th style="{th(t)}">Pupil</th>{heads}<th style="{th(t)}text-align:center;background:{t['accentsoft']};color:{t['primary']};">Total /100</th></tr></thead>
  <tbody>{rows}</tbody></table></div>'''

    picker = f'''<div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:11px;padding:14px 16px;border-bottom:1px solid {t['soft']};">
  {"".join(f"""<label style="font-size:12px;"><span style="display:block;margin-bottom:5px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:{t['muted']};">{lab}</span>
  <div style="min-width:{w}px;border:1px solid {t['border']};border-radius:{t['rsm']}px;padding:8px 11px;font-size:13.5px;background:{t['card']};color:{t['text']};display:flex;justify-content:space-between;gap:14px;align-items:center;">{val}
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="{t['faint']}" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></div></label>"""
  for lab,val,w in [("Term","First Term · 2026/2027",190),("Class","Basic 5 Gold",150),("Subject","Mathematics",150)])}
  <div style="background:{t['primary']};color:{t['onprimary']};border-radius:{t['rsm']}px;padding:9px 15px;font-size:13px;font-weight:600;">Open sheet</div>
</div>'''

    body = f'''<div style="display:flex;flex-direction:column;height:100%;">
  {topbar(t,"First Term · 2026/2027")}
  <div style="display:flex;flex:1;min-height:0;">
    {sidebar(t,"Mark sheet")}
    <main style="flex:1;padding:22px;overflow:hidden;">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:16px;">
        <div>
          <h1 class="disp" style="margin:0;font-size:25px;color:{t['text']};">Mark sheet</h1>
          <p style="margin:3px 0 0;font-size:13.5px;color:{t['muted']};">Basic 5 Gold · Mathematics · First Term</p>
        </div>
        <div style="display:flex;align-items:center;gap:9px;">
          <span style="font-size:12px;color:{t['muted']};">8 of 8 pupils entered</span>
          <div style="background:{t['primary']};color:{t['onprimary']};border-radius:{t['rsm']}px;padding:8px 15px;font-size:13px;font-weight:600;">Save sheet</div>
        </div>
      </div>
      {card(t, None, picker + table)}
      <p style="margin:12px 2px 0;font-size:12px;color:{t['faint']};">Class components are worth 80 marks, scaled to 50. The exam is worth 100, scaled to 50.</p>
    </main>
  </div>
</div>'''
    return shell(t, body)

# ── Terminal report card (A4, 794 x 1123 at 96dpi) ──────────────────────────
SUBJECTS = [("English Language",42,44,86,"1","Excellent"),("Mathematics",39,41,80,"1","Excellent"),
            ("Integrated Science",34,36,70,"2","Very Good"),("Social Studies",31,34,65,"3","Good"),
            ("Religious &amp; Moral Ed.",36,38,74,"2","Very Good"),("Ghanaian Language",29,32,61,"4","Credit"),
            ("Creative Arts",38,40,78,"2","Very Good"),("Computing",33,35,68,"3","Good"),
            ("French",27,29,56,"5","Credit"),("Physical Education",35,37,72,"2","Very Good"),
            ("Career Technology",30,33,63,"4","Credit")]

def report(t):
    rows = ""
    for i,(s,c,e,tot,g,r) in enumerate(SUBJECTS):
        zebra = f'background:{t["bg"]};' if i % 2 else ""
        rows += (f'<tr><td style="padding:6.5px 10px;font-size:12.5px;border-bottom:1px solid {t["soft"]};{zebra}">{s}</td>'
                 f'<td class="tabnum" style="padding:6.5px 10px;font-size:12.5px;text-align:center;border-bottom:1px solid {t["soft"]};{zebra}">{c}</td>'
                 f'<td class="tabnum" style="padding:6.5px 10px;font-size:12.5px;text-align:center;border-bottom:1px solid {t["soft"]};{zebra}">{e}</td>'
                 f'<td class="tabnum" style="padding:6.5px 10px;font-size:12.5px;text-align:center;font-weight:700;border-bottom:1px solid {t["soft"]};{zebra}">{tot}</td>'
                 f'<td class="tabnum" style="padding:6.5px 10px;font-size:12.5px;text-align:center;font-weight:700;color:{t["primary"]};border-bottom:1px solid {t["soft"]};{zebra}">{g}</td>'
                 f'<td style="padding:6.5px 10px;font-size:12px;color:{t["muted"]};border-bottom:1px solid {t["soft"]};{zebra}">{r}</td></tr>')

    def meta(label, value):
        return (f'<div><dt style="margin:0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:{t["muted"]};">{label}</dt>'
                f'<dd style="margin:2px 0 0;font-size:13px;font-weight:600;color:{t["text"]};">{value}</dd></div>')

    def band(label, value):
        return (f'<div style="border:1px solid {t["border"]};border-radius:{t["rsm"]}px;padding:8px 10px;background:{t["bg"]};">'
                f'<p style="margin:0;font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:{t["muted"]};">{label}</p>'
                f'<p style="margin:3px 0 0;font-size:12.5px;font-weight:600;color:{t["text"]};">{value}</p></div>')

    body = f'''<div style="width:794px;min-height:1123px;background:{t['card']};padding:44px 46px;display:flex;flex-direction:column;">

  <header style="display:flex;align-items:center;gap:16px;border-bottom:2.5px solid {t['primary']};padding-bottom:14px;">
    {crest(t,62)}
    <div style="flex:1;text-align:center;">
      <h1 class="disp" style="margin:0;font-size:25px;color:{t['text']};">St. Mary&rsquo;s Preparatory &amp; JHS</h1>
      <p style="margin:2px 0 0;font-size:11px;color:{t['muted']};">P.O. Box 214, Koforidua · 0244 123 456 · GES/ER/0417</p>
      <p style="margin:3px 0 0;font-size:11.5px;font-style:italic;color:{t['accent']};">Knowledge, Discipline, Service</p>
    </div>
    <div style="width:62px;"></div>
  </header>

  <p class="disp" style="margin:14px 0 0;text-align:center;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:{t['primary']};">Terminal Report</p>
  <p style="margin:2px 0 0;text-align:center;font-size:12px;color:{t['muted']};">First Term · 2026/2027 Academic Year</p>

  <dl style="display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:11px 18px;margin:16px 0 0;padding:14px 0;border-top:1px solid {t['border']};border-bottom:1px solid {t['border']};">
    {meta("Name","Abena Serwaa Mensah")}{meta("Admission no.","STM/2024/018")}
    {meta("Class","Basic 5 Gold")}{meta("Position","3rd of 26")}
    {meta("Aggregate","747 / 1100")}{meta("Average","67.9%")}
    {meta("Attendance","58 of 62 days")}{meta("Next term begins","7 January 2027")}
  </dl>

  <table style="margin-top:16px;">
    <thead><tr>
      <th style="text-align:left;padding:8px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['onprimary']};background:{t['primary']};">Subject</th>
      <th style="text-align:center;padding:8px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['onprimary']};background:{t['primary']};">Class /50</th>
      <th style="text-align:center;padding:8px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['onprimary']};background:{t['primary']};">Exam /50</th>
      <th style="text-align:center;padding:8px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['onprimary']};background:{t['primary']};">Total</th>
      <th style="text-align:center;padding:8px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['onprimary']};background:{t['primary']};">Grade</th>
      <th style="text-align:left;padding:8px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['onprimary']};background:{t['primary']};">Remark</th>
    </tr></thead>
    <tbody>{rows}</tbody>
  </table>

  <div style="display:grid;grid-template-columns:repeat(4, minmax(0,1fr));gap:9px;margin-top:16px;">
    {band("Conduct","Respectful and calm")}{band("Attitude","Very good")}
    {band("Interest","Reading, athletics")}{band("Punctuality","Excellent")}
  </div>

  <div style="margin-top:16px;display:flex;flex-direction:column;gap:11px;">
    <div style="border-left:3px solid {t['accent']};padding:2px 0 2px 12px;">
      <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['muted']};">Class teacher&rsquo;s remark</p>
      <p style="margin:3px 0 0;font-size:12.5px;line-height:1.5;color:{t['text']};text-wrap:pretty;">Abena has worked steadily all term and her written English is now among the strongest in the class. She should speak up more in group work.</p>
    </div>
    <div style="border-left:3px solid {t['accent']};padding:2px 0 2px 12px;">
      <p style="margin:0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:{t['muted']};">Headteacher&rsquo;s remark</p>
      <p style="margin:3px 0 0;font-size:12.5px;line-height:1.5;color:{t['text']};text-wrap:pretty;">A pleasing report. Keep it up.</p>
    </div>
  </div>

  <div style="margin-top:auto;padding-top:26px;display:flex;align-items:flex-end;justify-content:space-between;gap:30px;">
    <div style="flex:1;">
      <svg width="150" height="42" viewBox="0 0 150 42" fill="none" aria-hidden="true">
        <path d="M6 30c14-20 20 6 30-8s14 12 24-2 16 10 26-4 18 8 26-2" stroke="{t['text']}" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M96 26c8 2 14 0 18-4" stroke="{t['text']}" stroke-width="1.7" stroke-linecap="round"/>
      </svg>
      <div style="border-top:1px solid {t['text']};margin-top:2px;padding-top:5px;">
        <p style="margin:0;font-size:11.5px;font-weight:600;color:{t['text']};">Mrs. Grace Amoah</p>
        <p style="margin:0;font-size:10.5px;color:{t['muted']};">Headteacher</p>
      </div>
    </div>
    <div style="flex:1;">
      <div style="height:42px;"></div>
      <div style="border-top:1px solid {t['border']};margin-top:2px;padding-top:5px;">
        <p style="margin:0;font-size:11.5px;font-weight:600;color:{t['faint']};">Parent / Guardian</p>
        <p style="margin:0;font-size:10.5px;color:{t['faint']};">Signature</p>
      </div>
    </div>
  </div>
</div>'''
    return shell(t, body)


NOTES = {
 "A": "Deep forest green with a gold accent; Newsreader for headings over Public Sans.\n\nKeeps today's density and card anatomy exactly — only palette and type change, so it is the cheapest to ship and the least risky.\n\nTradeoff: reads traditional and collegiate. Safe, but it will not turn heads.",
 "B": "Institutional navy with a teal accent; IBM Plex throughout. Tighter rows, 6px radii, more rows per screen.\n\nBuilt for volume work — a bursar reconciling fees or a head scanning eleven classes sees more without scrolling.\n\nTradeoff: the most efficient and the least warm. Parents meet it only on the report card, where it reads governmental.",
 "C": "Cream ground, clay primary, olive accent; Instrument Serif over Karla. Larger radii, more air.\n\nThe most distinctive, and by far the best printed report card — it looks like a document a school is proud to hand over.\n\nTradeoff: lowest information density, and a cream ground is harder to read on a cheap phone in bright sun — worth weighing for Ghana.",
}

# ── Emit ────────────────────────────────────────────────────────────────────
out = pathlib.Path(".")
names = {}
for k, t in D.items():
    dash = "Main" if k == "A" else f"Dashboard{k}"
    (out / f"{dash}.dc.html").write_text(dashboard(t))
    (out / f"MarkSheet{k}.dc.html").write_text(marksheet(t))
    (out / f"Report{k}.dc.html").write_text(report(t))
    names[k] = dash

DW, DH, RW, RH = 1250, 800, 794, 1123
rows_y = [0, 1420, 2840]
canvas = {"artboards": [], "annotations": [], "launch": {"view": "canvas"}}
for i, k in enumerate(["A", "B", "C"]):
    y = rows_y[i]
    t = D[k]
    canvas["artboards"] += [
      {"file": f"{names[k]}.dc.html", "x": 0,    "y": y, "w": DW, "h": DH, "title": f"{k} · Dashboard"},
      {"file": f"MarkSheet{k}.dc.html", "x": 1370, "y": y, "w": DW, "h": DH, "title": f"{k} · Mark sheet"},
      {"file": f"Report{k}.dc.html", "x": 2740, "y": y, "w": RW, "h": RH, "title": f"{k} · Report card", "print": "fixed"},
    ]
    canvas["annotations"].append({
      "id": f"dir-{k.lower()}", "x": -420, "y": y + 10, "w": 350,
      "text": f"{k} — {t['name']}\n\n{NOTES[k]}"})
(out / "canvas.json").write_text(json.dumps(canvas, indent=2))
print("wrote", len(canvas["artboards"]), "artboards")
