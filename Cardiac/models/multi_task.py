"""
Priority 3 -- Multi-task model: shared encoder + two heads.

  Beat head  : 4-class AAMI (trained on MIT-BIH beats)
  Rhythm head: 4-class rhythm (trained on CinC full records)

The RHYTHM head is discarded at deployment. Only the shared encoder + beat
head is exported. The rhythm head's loss acts as a regularizer that biases
the encoder toward features that distinguish sinus rhythm from AF / Other.

The encoder is architecturally identical to the student-CNN encoder, so the
state dict transfers.
"""
import os
import sys
import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (CONV1_CHANNELS, CONV2_CHANNELS, CONV3_CHANNELS,
                     CONV1_KERNEL, CONV2_KERNEL, CONV3_KERNEL,
                     FC_HIDDEN, DROPOUT_RATE, RR_FEATURE_DIM, NUM_CLASSES,
                     MT_RHYTHM_CLASSES)
from models.student_cnn import ConvBlock


class MultiTaskECG(nn.Module):
    """Shared encoder + beat head + rhythm head.

    Beat forward:    (beat_1s, rr)          -> logits (B, 4)
    Rhythm forward:  (beats_per_record, rr) -> logits (B, 4)
       Rhythm does beat-level feature extraction, then pools across a record.
    """

    def __init__(self, num_beat_classes=NUM_CLASSES,
                 num_rhythm_classes=None, rr_dim=RR_FEATURE_DIM,
                 dropout=DROPOUT_RATE):
        super().__init__()
        if num_rhythm_classes is None:
            num_rhythm_classes = len(MT_RHYTHM_CLASSES)

        # Shared encoder (same names as ECGStudentCNN / SSLEncoder)
        self.block1 = ConvBlock(1, CONV1_CHANNELS, CONV1_KERNEL, pool_size=2)
        self.block2 = ConvBlock(CONV1_CHANNELS, CONV2_CHANNELS, CONV2_KERNEL, pool_size=2)
        self.block3 = ConvBlock(CONV2_CHANNELS, CONV3_CHANNELS, CONV3_KERNEL, pool_size=0)
        self.gap = nn.AdaptiveAvgPool1d(1)

        # Beat head (mirrors student CNN trunk+head)
        self.beat_fc1 = nn.Linear(CONV3_CHANNELS + rr_dim, FC_HIDDEN)
        self.beat_dropout = nn.Dropout(dropout)
        self.beat_fc2 = nn.Linear(FC_HIDDEN, num_beat_classes)

        # Rhythm head (takes pooled features only; no RR)
        self.rhythm_fc1 = nn.Linear(CONV3_CHANNELS, FC_HIDDEN)
        self.rhythm_dropout = nn.Dropout(dropout)
        self.rhythm_fc2 = nn.Linear(FC_HIDDEN, num_rhythm_classes)

    def encode(self, x_beat):
        # x_beat: (B, 128, 1)
        x = x_beat.permute(0, 2, 1)
        x = self.block1(x); x = self.block2(x); x = self.block3(x)
        return self.gap(x).squeeze(-1)         # (B, C3)

    def forward_beat(self, x_beat, x_rr):
        z = self.encode(x_beat)
        h = torch.cat([z, x_rr], dim=1)
        h = torch.relu(self.beat_fc1(h))
        h = self.beat_dropout(h)
        return self.beat_fc2(h)

    def forward_rhythm(self, beats_per_record_list):
        """Input: list of (K_i, 128, 1) tensors, one per record.

        Aggregates beat-level features via mean pool within each record,
        then classifies the record.
        """
        outs = []
        for beats in beats_per_record_list:
            z = self.encode(beats)             # (K, C3)
            rec_feat = z.mean(dim=0, keepdim=True)   # (1, C3)
            h = torch.relu(self.rhythm_fc1(rec_feat))
            h = self.rhythm_dropout(h)
            outs.append(self.rhythm_fc2(h))
        return torch.cat(outs, dim=0)          # (B_records, R)

    def export_student_cnn_state(self):
        """Strip the rhythm head -- return a state_dict keyed so that
        ECGStudentCNN.load_state_dict(..., strict=False) works."""
        state = self.state_dict()
        out = {}
        keep_prefixes = ('block1.', 'block2.', 'block3.')
        for k, v in state.items():
            if k.startswith(keep_prefixes):
                out[k] = v
            elif k.startswith('beat_fc1.'):
                out[k.replace('beat_fc1.', 'fc1.')] = v
            elif k.startswith('beat_fc2.'):
                out[k.replace('beat_fc2.', 'fc2.')] = v
        return out
