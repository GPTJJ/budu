#!/bin/sh
set -e
git config core.hooksPath .githooks
git config core.autocrlf input
git config core.filemode false
echo "[setup-git] hooksPath=.githooks, autocrlf=input"
