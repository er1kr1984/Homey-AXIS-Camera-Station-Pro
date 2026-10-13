# Adds sv, de and nl next to every English text (compose files) and writes
# locales/sv.json, de.json and nl.json from locales/en.json. Run after changing texts.
import glob, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from translations import T

LANGS = ['sv', 'de', 'nl']
missing = set()

def translate(text, lang):
    if text not in T:
        missing.add(text)
        return text
    return T[text][LANGS.index(lang)]

def walk(o):
    if isinstance(o, dict):
        if 'en' in o and isinstance(o['en'], str) and all(isinstance(v, str) for v in o.values()):
            for lang in LANGS:
                o[lang] = translate(o['en'], lang)
            return
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)

files = glob.glob('.homeycompose/**/*.json', recursive=True) + glob.glob('drivers/*/*.compose.json') + ['widgets/live/widget.compose.json']
for f in files:
    d = json.load(open(f))
    walk(d)
    with open(f, 'w') as fh:
        json.dump(d, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

en = json.load(open('locales/en.json'))
def tr_tree(o, lang):
    if isinstance(o, dict):
        return {k: tr_tree(v, lang) for k, v in o.items()}
    return translate(o, lang)
for lang in LANGS:
    with open(f'locales/{lang}.json', 'w') as fh:
        json.dump(tr_tree(en, lang), fh, indent=2, ensure_ascii=False)
        fh.write('\n')

if missing:
    print('MISSING translations:', *sorted(missing), sep='\n  ')
    sys.exit(1)
print(f'translated {len(files)} compose files and {len(LANGS)} locale files')
