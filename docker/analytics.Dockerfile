FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "lifelines>=0.29" "pandas>=2.2" "numpy>=1.26" "psycopg[binary]>=3.2" "xgboost>=2.1"
COPY analytics/train.py analytics/scheduler.py ./
CMD ["python", "scheduler.py"]
