# Copyright (c) 2026 Jim C K Flaten
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build environment for the Android app: everything `mobile/run`
# needs to build the site (Go), sync it into the Capacitor project
# (Node), render the app icons (rsvg-convert) and build the APK/AAB
# (JDK, Android SDK). The `emulator`
# target adds an emulator and a system image for smoke tests.
#
# Versions are pinned: Capacitor 8 needs JDK 21 and Android SDK 36;
# Go follows go.mod.

FROM golang:1.27.4-bookworm AS go
FROM eclipse-temurin:21-jdk-noble AS jdk

FROM node:24-bookworm AS build
COPY --from=go /usr/local/go /usr/local/go
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=/usr/local/go/bin:$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH

ARG CMDLINE_TOOLS=13114758
ARG ANDROID_PLATFORM=android-36
# The Android Gradle plugin picks its own build-tools version (35 for
# Capacitor 8's); the SDK dir is read-only at build time, so preinstall it.
ARG BUILD_TOOLS=35.0.0
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
 && mkdir -p $ANDROID_HOME/cmdline-tools \
 && curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip \
 && unzip -q /tmp/tools.zip -d /tmp/tools && mv /tmp/tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm -rf /tmp/tools /tmp/tools.zip \
 && yes | sdkmanager --licenses >/dev/null \
 && sdkmanager --install "platform-tools" "platforms;${ANDROID_PLATFORM}" "build-tools;${BUILD_TOOLS}" >/dev/null \
 # Builds run as the host user (see mobile/run); let Gradle read the SDK.
 && chmod -R a+rX $ANDROID_HOME
# rsvg-convert, for the app icons (mobile/build assets).
RUN apt-get update && apt-get install -y --no-install-recommends librsvg2-bin && rm -rf /var/lib/apt/lists/*

FROM build AS emulator
ARG SYSTEM_IMAGE="system-images;android-36;google_apis;x86_64"
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpulse0 libnss3 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 libgbm1 libasound2 libxkbfile1 \
 && rm -rf /var/lib/apt/lists/* \
 && sdkmanager --install "emulator" "${SYSTEM_IMAGE}" >/dev/null \
 && chmod -R a+rX $ANDROID_HOME
ENV PATH=$ANDROID_HOME/emulator:$PATH
