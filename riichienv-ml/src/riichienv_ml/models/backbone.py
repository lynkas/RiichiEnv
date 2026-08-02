import torch
import torch.nn as nn


class ChannelAttention(nn.Module):
    """Self-designed channel gating for the residual CNN blocks.

    Design: Channel Contrast Gating (CCG).

    Each channel's activation profile over the tile dimension is summarized
    by two complementary statistics:

      * ``mean`` -- the DC level: how strongly the channel responds on
        average across all tile positions;
      * ``contrast = max - min`` -- the activation spread: how much the
        channel discriminates between tile positions.

    ``mean`` is projected by a single linear map to a gate in (0, 1) via
    sigmoid; ``contrast`` is projected by an independent linear map to a
    modulation in (-1, 1) via tanh.  The per-channel scale is
    ``gate * (1 + 0.5 * modulation)``, so a channel whose activations are
    flat (low contrast) is suppressed while a "peaky" channel is boosted
    beyond its average-level gate.

    Rationale vs. classic squeeze-and-excitation gating: there is no
    bottleneck shared-MLP and no max-pooling; each statistic feeds its own
    tiny linear gate, keeping the module low-capacity (4 parameters) and the
    two gating signals independently interpretable.
    """

    def __init__(self, channels: int):
        super().__init__()
        self.gate_proj = nn.Linear(1, 1)    # mean     -> (0, 1)   gate
        self.mod_proj = nn.Linear(1, 1)     # contrast -> (-1, 1)  modulation

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mean = x.mean(dim=-1, keepdim=True)                        # (B, C, 1)
        contrast = (x.amax(dim=-1) - x.amin(dim=-1)).unsqueeze(-1)  # (B, C, 1)
        gate = self.gate_proj(mean).sigmoid()
        modulation = self.mod_proj(contrast).tanh()
        scale = gate * (1.0 + 0.5 * modulation)                    # (B, C, 1)
        return x * scale


class ResBlock(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.conv1 = nn.Conv1d(channels, channels, kernel_size=3, padding=1)
        self.bn1 = nn.BatchNorm1d(channels)
        self.relu = nn.ReLU(inplace=True)
        self.conv2 = nn.Conv1d(channels, channels, kernel_size=3, padding=1)
        self.bn2 = nn.BatchNorm1d(channels)
        self.ca = ChannelAttention(channels)

    def forward(self, x):
        residual = x
        out = self.conv1(x)
        out = self.bn1(out)
        out = self.relu(out)
        out = self.conv2(out)
        out = self.bn2(out)
        out = self.ca(out)
        out += residual
        out = self.relu(out)
        return out


class ResNetBackbone(nn.Module):
    """Shared CNN backbone: Conv1d projection -> N ResBlocks -> Flatten -> FC.

    Input:  (B, in_channels, tile_dim)
    Output: (B, fc_dim)
    """
    def __init__(self, in_channels: int = 74, conv_channels: int = 64,
                 num_blocks: int = 3, fc_dim: int = 256, tile_dim: int = 34):
        super().__init__()
        self.conv_in = nn.Conv1d(in_channels, conv_channels, kernel_size=3, padding=1)
        self.bn_in = nn.BatchNorm1d(conv_channels)
        self.relu = nn.ReLU(inplace=True)
        self.res_blocks = nn.ModuleList([ResBlock(conv_channels) for _ in range(num_blocks)])
        self.flatten = nn.Flatten()
        self.fc = nn.Linear(conv_channels * tile_dim, fc_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.relu(self.bn_in(self.conv_in(x)))
        for block in self.res_blocks:
            out = block(out)
        out = self.flatten(out)
        out = self.relu(self.fc(out))
        return out
