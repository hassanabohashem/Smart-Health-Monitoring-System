import torch
import torch.nn as nn
import torch.nn.functional as F

class BarometerFusionNet(nn.Module):
    """
    Dual-Stream 1D-CNN for Sensor Fusion.
    Stream A: Analyzes the high-frequency 6-axis IMU data (Accel + Gyro) to detect the impact spike.
    Stream B: Analyzes the low-frequency 1-axis Barometer data to detect a drop in altitude.
    Fusion: The extracted feature vectors from both streams are concatenated and fed into the final Dense layers.
    """
    def __init__(self, imu_channels=6, baro_channels=1, num_classes=2):
        super(BarometerFusionNet, self).__init__()

        # --- STREAM A: IMU Feature Extractor (Similar to LiteFallNet) ---
        self.imu_conv1 = nn.Conv1d(in_channels=imu_channels, out_channels=32, kernel_size=5, stride=1, padding=2)
        self.imu_bn1 = nn.BatchNorm1d(32)
        self.imu_pool1 = nn.MaxPool1d(kernel_size=2, stride=2)

        self.imu_conv2 = nn.Conv1d(in_channels=32, out_channels=64, kernel_size=3, stride=1, padding=1)
        self.imu_bn2 = nn.BatchNorm1d(64)
        self.imu_pool2 = nn.MaxPool1d(kernel_size=2, stride=2)
        
        self.imu_conv3 = nn.Conv1d(in_channels=64, out_channels=128, kernel_size=3, stride=1, padding=1)
        self.imu_bn3 = nn.BatchNorm1d(128)
        self.imu_pool3 = nn.MaxPool1d(kernel_size=2, stride=2)
        # Expected IMU feature size after pooling (assuming 200 input sequence length):
        # 200 -> 100 -> 50 -> 25
        # Flattened IMU features: 25 * 128 = 3200

        # --- STREAM B: Barometer (Altitude) Feature Extractor ---
        # Barometer data is smoother, so we use larger kernels and fewer channels
        self.baro_conv1 = nn.Conv1d(in_channels=baro_channels, out_channels=8, kernel_size=11, stride=1, padding=5)
        self.baro_bn1 = nn.BatchNorm1d(8)
        self.baro_pool1 = nn.MaxPool1d(kernel_size=4, stride=4)

        self.baro_conv2 = nn.Conv1d(in_channels=8, out_channels=16, kernel_size=7, stride=1, padding=3)
        self.baro_bn2 = nn.BatchNorm1d(16)
        self.baro_pool2 = nn.MaxPool1d(kernel_size=5, stride=5)
        # Expected Baro feature size after pooling (assuming 200 input sequence length):
        # 200 -> 50 -> 10
        # Flattened Baro features: 10 * 16 = 160

        # --- FUSION LAYER ---
        # We concatenate the Flattened IMU (3200) + Flattened Baro (160)
        self.fused_features_size = 3200 + 160

        self.fc1 = nn.Linear(self.fused_features_size, 128)
        self.dropout = nn.Dropout(0.5)
        self.fc2 = nn.Linear(128, num_classes)

    def forward(self, imu_x, baro_x):
        # Input shape expected: (batch_size, channels, seq_length)
        
        # --- Run Stream A ---
        x_imu = F.relu(self.imu_bn1(self.imu_conv1(imu_x)))
        x_imu = self.imu_pool1(x_imu)
        
        x_imu = F.relu(self.imu_bn2(self.imu_conv2(x_imu)))
        x_imu = self.imu_pool2(x_imu)
        
        x_imu = F.relu(self.imu_bn3(self.imu_conv3(x_imu)))
        x_imu = self.imu_pool3(x_imu)
        
        x_imu = torch.flatten(x_imu, 1)

        # --- Run Stream B ---
        x_baro = F.relu(self.baro_bn1(self.baro_conv1(baro_x)))
        x_baro = self.baro_pool1(x_baro)
        
        x_baro = F.relu(self.baro_bn2(self.baro_conv2(x_baro)))
        x_baro = self.baro_pool2(x_baro)
        
        x_baro = torch.flatten(x_baro, 1)

        # --- FUSION ---
        # Concatenate horizontally along the feature dimension
        fused = torch.cat((x_imu, x_baro), dim=1)

        # --- Final Classification ---
        out = F.relu(self.fc1(fused))
        out = self.dropout(out)
        out = self.fc2(out)

        return out
