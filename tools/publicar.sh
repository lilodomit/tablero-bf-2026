#!/bin/zsh
# Cifra el plan con la contraseña real y sube el proyecto a GitHub.
set -e
cd "$(dirname "$0")/.."

read "REPO?URL del repositorio (https://github.com/usuario/nombre.git): "
read -s "PW?Contraseña del dashboard (igual al secret DASHBOARD_PASSWORD): "
echo

DASHBOARD_PASSWORD="$PW" node tools/seal-plan.mjs

[ -d .git ] || git init -b main
git config user.name "Dashboard Buen Fin"
git config user.email "dashboard@users.noreply.github.com"
git add -A
git diff --cached --quiet || git commit -m "Dashboard Buen Fin Twins & Icons" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO"
git push -u origin main
echo "Listo. Revisa la pestaña Actions del repositorio."
