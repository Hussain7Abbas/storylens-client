.PHONY: help install dev build typecheck test pack dist-mac dist-win smoke-browser

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

BLUE := $(shell printf '\033[34m')
GREEN := $(shell printf '\033[32m')
YELLOW := $(shell printf '\033[33m')
RESET := $(shell printf '\033[0m')

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

help:
	@echo ""
	@echo "$(BLUE)Story Lens desktop client$(RESET)"
	@echo "  $(GREEN)install$(RESET)         $(YELLOW)bun install$(RESET)"
	@echo "  $(GREEN)dev$(RESET)             build and launch Electron"
	@echo "  $(GREEN)build$(RESET)           compile the desktop app"
	@echo ""
	@echo "$(BLUE)Quality$(RESET)"
	@echo "  $(GREEN)typecheck$(RESET)       TypeScript without output"
	@echo "  $(GREEN)test$(RESET)            client service tests"
	@echo "  $(GREEN)smoke-browser$(RESET)   Chrome summary flow against a running client"
	@echo ""
	@echo "$(BLUE)Packages$(RESET)"
	@echo "  $(GREEN)pack$(RESET)            unpacked Electron app"
	@echo "  $(GREEN)dist-mac$(RESET)        macOS DMG"
	@echo "  $(GREEN)dist-win$(RESET)        Windows NSIS installer"
	@echo ""

install:
	@cd "$(ROOT)" && bun install

dev:
	@cd "$(ROOT)" && bun run dev

build:
	@cd "$(ROOT)" && bun run build

typecheck:
	@cd "$(ROOT)" && bun run typecheck

test:
	@cd "$(ROOT)" && bun test

smoke-browser:
	@cd "$(ROOT)" && bun run smoke:browser

pack:
	@cd "$(ROOT)" && bun run pack

dist-mac:
	@cd "$(ROOT)" && bun run dist:mac

dist-win:
	@cd "$(ROOT)" && bun run dist:win
