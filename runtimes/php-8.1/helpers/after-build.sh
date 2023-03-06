#!/bin/sh
# Fail build if any command fails
set -e

echo "Packing build ..."

# Prepare empty folder to prevent errors with copying
mkdir -p /usr/local/build/vendor

# Install server dependencies
cd /usr/local/server
composer update --no-interaction --ignore-platform-reqs --optimize-autoloader --prefer-dist --no-dev
mkdir -p /usr/local/build/vendor-server
cp -R /usr/local/server/vendor/. /usr/local/build/vendor-server/

# Store entrypoint into build. Will be used during start process
touch /usr/local/build/.open-runtimes
echo "OPEN_RUNTIMES_ENTRYPOINT=$OPEN_RUNTIMES_ENTRYPOINT" > /usr/local/build/.open-runtimes

# Finish build by preparing tar to use for starting the runtime
tar -C /usr/local/build --exclude code.tar.gz -zcf /mnt/code/code.tar.gz .

echo "Build finished."