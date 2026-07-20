# Euphoriam Node backend — dev image with hot reload (nodemon).
FROM node:20-bookworm-slim

WORKDIR /app

# canvas + native deps for PDF/barcode generation
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "dev"]
