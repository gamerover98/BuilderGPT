# BuilderGPT Dockerfile
FROM python:3.11-slim

# Prevent Python from writing .pyc files and enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install build tools, cmake, compilers, Python headers, and graphics libraries
# required for compiling C/C++ extensions like amulet-leveldb and quickjs
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    gcc \
    g++ \
    git \
    python3-dev \
    zlib1g-dev \
    libbz2-dev \
    libsnappy-dev \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Upgrade pip and wheel, but PIN setuptools < 71.0.0 because pkg_resources was removed in v71
RUN pip install --no-cache-dir --upgrade pip "setuptools<71.0.0" wheel

# Copy requirements first to leverage Docker layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Ensure generated directory exists for output files
RUN mkdir -p generated temp_uploads

# Expose Streamlit default port
EXPOSE 8501

# Healthcheck to verify Streamlit service status
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8501/_stcore/health || exit 1

# Launch Streamlit app
CMD ["streamlit", "run", "run_app.py", "--server.address=0.0.0.0", "--server.port=8501"]
