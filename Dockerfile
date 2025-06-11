# Use a base image that has FFmpeg
FROM jrottenberg/ffmpeg:4.4-ubuntu

# Install Node.js and npm
RUN apt-get update && \
    apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm

# Set working directory
WORKDIR /app

# Copy all project files
COPY . .

# Install dependencies
RUN npm install

# Expose the port your app runs on
EXPOSE 3001

# Start the Node.js server
CMD ["node", "index.js"]
