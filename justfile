# List the recipes
default:
    @just --list

# Install dependencies and the git hooks
setup:
    pnpm install

# Watch your pull requests in the foreground
run *args:
    pnpm run prwatch run {{args}}

# Show what would be delivered right now, without sending anything
once *args:
    pnpm run prwatch once {{args}}

# Format, lint, typecheck and test
check:
    pnpm run check

# Format every file in place
format:
    pnpm run format
