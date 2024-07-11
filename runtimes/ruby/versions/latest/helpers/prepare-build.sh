#!/bin/sh
# Fail build if any command fails
set -e

# Link user's depenrencies
if [ -f "Gemfile" ]; then
    echo "eval_gemfile '/usr/local/build/Gemfile'" >> /usr/local/server/Gemfile
fi

bundle config set --local path 'vendor/bundle'