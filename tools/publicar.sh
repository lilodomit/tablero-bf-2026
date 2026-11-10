#!/bin/zsh
# Cifra el plan con la contraseña del dashboard y sube los cambios a GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."

GH="$(command -v gh || echo "$HOME/.local/gh-2.103.3/bin/gh")"
REPO="$(git remote get-url origin | sed -E 's#https://github.com/##; s#\.git$##')"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

read -s "PW?Contraseña del dashboard (la misma que usa el equipo): "; echo

# Antes de subir, comprueba que la contraseña abra los datos que ya están publicados.
DASHBOARD_PASSWORD="$PW" DATA_URL="https://${OWNER:l}.github.io/$NAME/data.enc" node --input-type=module -e '
import { open } from "./scripts/crypto.mjs";
const text = await (await fetch(process.env.DATA_URL + "?ts=" + Date.now())).text();
try { await open(text, process.env.DASHBOARD_PASSWORD); }
catch { console.error("Esa contraseña no abre el dashboard publicado. No se subió nada."); process.exit(1); }
'

DASHBOARD_PASSWORD="$PW" node tools/seal-plan.mjs

git add -A
if git ls-files | grep -Eq '(^|/)(plan(-[a-z]+)?\.json|\.env|build-plan\.py|build-nook\.mjs|README\.md|data\.enc|publicar-primera-vez\.sh|agregar-nook\.sh)$'; then
  echo "Se iba a subir un archivo privado. Se detuvo antes de publicar."
  exit 1
fi
git diff --cached --quiet || git commit -q -m "Actualizar plan del dashboard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -c credential.helper= -c "credential.helper=!$GH auth git-credential" push -q origin main
echo "Listo. En un par de minutos queda publicado: https://github.com/$REPO/actions"
